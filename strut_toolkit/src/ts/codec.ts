import armorTemplate from '../resources/armorTemplate.json';
import {isEmpty, isValidPath} from './utils';
import {
    STRUT_MODEL_ID, LEGACY_MODEL_ID,
    GeckoModelType, PROPERTY_FILEPATH_CACHE,
    PROPERTY_MODEL_TYPE,
    PROPERTY_MODID, SETTING_ALWAYS_SHOW_DISPLAY, SETTING_AUTO_PARTICLE_TEXTURE,
    SETTING_REMEMBER_EXPORT_LOCATIONS
} from "./constants";

const codec = Codecs.bedrock;

// This gets automatically applied by Blockbench, we don't need to do anything with it
export const format = new ModelFormat(STRUT_MODEL_ID, {
    name: "Strut Animated Model",
    category: "minecraft",
    description: "Animated Model for Java mods using Strut",
    icon: "view_in_ar",
    rotate_cubes: true,
    box_uv: true,
    optional_box_uv: true,
    single_texture: true,
    bone_rig: true,
    // Lets the outliner offer meshes at all, and per-texture UV grids rather than a single
    // project-wide one - both load-bearing for fork phase 6 stage 2's mesh/cube export (see
    // docs/BINARY_CODEC_PLAN.md §3's note on armature_rig being similarly load-bearing for
    // stage 4's armature authoring)
    meshes: true,
    per_texture_uv_size: true,
    // Offers the armature option in the outliner at all - without it there is no way to author a
    // skinned mesh to test fork phase 6 stage 4's export/import against (see
    // docs/BINARY_CODEC_PLAN.md §6 stage 4)
    armature_rig: true,
    centered_grid: true,
    animated_textures: true,
    select_texture_for_particles: true,
    animation_files: true,
    locators: true,
    codec: Codecs.project,
    display_mode: false,
    animation_mode: true,
})

// A .bbmodel saved under this plugin's pre-rebrand identity (LEGACY_MODEL_ID's own doc comment
// has the real Blockbench mechanism) still opens directly as Strut, rather than needing a manual
// "Convert Project" step or failing to open at all once only strut_model is registered.
// Non-enumerable deliberately: `Formats[LEGACY_MODEL_ID]` still resolves for the direct-lookup
// open path, but a plain assignment here also made this format enumerate twice under
// `Object.keys(Formats)` (once per key, both pointing at this same object) - which is exactly
// what "Convert Project" showing "Strut Animated Model" twice turned out to be, live-verified
// against a real Blockbench session. Hiding this key from enumeration is what a dialog that
// lists every registered format actually needs; a lookup by exact key is unaffected either way
Object.defineProperty(Formats, LEGACY_MODEL_ID, { value: format, enumerable: false, configurable: true, writable: true });

// Override the new project panel to allow customisation
format.new = function() {
    if (newProject(this))
        return openProjectSettingsDialog();
}

/**
 * Open a GeckoLib-customised project settings dialog (usually found when creating a new project, or via the File -> Project... menu item
 */
export function openProjectSettingsDialog() {
    if (Project instanceof ModelProject)
        return createProjectSettingsDialog(Project, createProjectSettingsForm(Project));
}

/**
 * Internal function for determining the placeholder value for the <code>model_identifier</code> form element in dialog windows
 */
function getObjectIdPlaceholder(formResult?: {[key: string]: FormResultValue}) {
    const name = formResult?.['name'] as string;
    const modelType = formResult?.[PROPERTY_MODEL_TYPE] as string;

    if (!name && !modelType)
        return 'my_entity';

    const invalidPathChar = new RegExp('[^_\\-/.a-z0-9]+', 'g')
    const pseudoWhitepaceChar = new RegExp('[\\s&-]+', 'g')

    if (name)
        return name.toLowerCase().replace(pseudoWhitepaceChar, "_").replace(invalidPathChar, "");

    switch (GeckoModelType[modelType]) {
        case GeckoModelType.ENTITY: return 'my_entity'
        case GeckoModelType.BLOCK: return 'my_block';
        case GeckoModelType.ITEM: return 'my_item';
        case GeckoModelType.ARMOR: return 'my_armor';
        case GeckoModelType.OBJECT: return 'my_object';
        default: return 'my_entity';
    }
}

/**
 * Create the Project Settings dialog form for use in both new projects and editing existing ones
 */
function createProjectSettingsForm(Project: ModelProject) {
    const form = {format: {type: 'info', label: 'data.format', text: Format.name||'unknown', description: Format.description} as DialogFormElement}
    const properties = ModelProject['properties'];

    const modelType = properties[PROPERTY_MODEL_TYPE];

    if (modelType) {
        form[PROPERTY_MODEL_TYPE] = {
            label: modelType.label,
            description: modelType.description,
            default: GeckoModelType.ENTITY.toUpperCase(),
            value: GeckoModelType[Project[PROPERTY_MODEL_TYPE].toUpperCase()].toUpperCase(),
            placeholder: modelType.placeholder,
            type: 'select',
            // blockbench-types declares Property.options as Record<string, string>, too narrow for
            // the dynamic-options case Property actually supports at runtime; cast around it
            options: typeof modelType.options == 'function' ? (modelType.options as any)() : modelType.options,
        }
    }

    for (const key in properties) {
        const property = properties[key];

        if (property.exposed === false || !Condition(property.condition))
            continue;

        const entry = form[property.name] = {
            label: property.label,
            description: property.description,
            value: Project[property.name],
            placeholder: property.placeholder,
            type: property.type
        }

        if (property.name === 'name') {
            entry.label = 'Project Name'
            entry.placeholder = 'My Project'
            entry.description = 'The name of the Blockbench project'
        }
        else if (property.name === 'model_identifier') {
            entry.label = 'Object ID'
            entry.description = 'The registered id of the object this model represents, for exporting purposes'
            entry.placeholder = getObjectIdPlaceholder()
        }

        switch (property.type) {
            case 'boolean':
                entry.type = 'checkbox'
                break;
            case 'string':
                entry.type = 'text';
                break;
            default:
                if (property.options) {
                    entry['options'] = typeof property.options == 'function' ? (property.options as any)() : property.options;
                    entry.type = 'select';
                }
                break;
        }
    }

    if (form['name'] && (Project.save_path || Project.export_path || Format.image_editor) && !Format['legacy_editable_file_name'])
        delete form['name'];

    form['uv_mode'] = {
        label: 'dialog.project.default_uv_mode',
        description: 'dialog.project.default_uv_mode.description',
        type: 'select',
        condition: Format.optional_box_uv,
        options: {
            face_uv: 'dialog.project.uv_mode.face_uv',
            box_uv: 'dialog.project.uv_mode.box_uv',
        },
        value: Project.box_uv ? 'box_uv' : 'face_uv',
    };

    form['texture_size'] = {
        label: 'dialog.project.texture_size',
        type: 'vector',
        dimensions: 2,
        value: [Project.texture_width, Project.texture_height],
        min: 1
    };

    return form;
}

/**
 * Create the 'new project' popup dialogue for GeckoLib projects.
 * <p>
 * The contents of this is mostly a copy of <code>project.js</code> "project_window" action declaration (Copyright Blockbench)<br>
 * Periodically check this is up-to-date with Blockbench to ensure ongoing compatibility
 * @return false if the user clicks <code>cancel</code>, otherwise true
 */
function createProjectSettingsDialog(Project: ModelProject, form: {[formElement: string]: '_' | DialogFormElement}) {
    const dialog = new Dialog({
        id: 'project',
        title: 'dialog.project.title',
        width: 500,
        form,
        onConfirm: function(formResult) {
            let save;
            const box_uv = formResult['uv_mode'] == 'box_uv';
            const texture_width = Math.clamp(formResult['texture_size'][0], 1, Infinity);
            const texture_height = Math.clamp(formResult['texture_size'][1], 1, Infinity);

            if (Project.box_uv != box_uv || Project.texture_width != texture_width || Project.texture_height != texture_height) {
                // Adjust UV Mapping if resolution changed
                if (!Project.box_uv && !box_uv && !Format['per_texture_uv_size'] && (Project.texture_width != texture_width || Project.texture_height != texture_height)) {
                    save = Undo.initEdit({elements: [...Cube.all, ...Mesh.all], uv_only: true, uv_mode: true} as UndoAspects)

                    Cube.all.forEach(cube => {
                        for (const key in cube.faces) {
                            const uv = cube.faces[key].uv;
                            uv[0] *= texture_width / Project.texture_width;
                            uv[2] *= texture_width / Project.texture_width;
                            uv[1] *= texture_height / Project.texture_height;
                            uv[3] *= texture_height / Project.texture_height;
                        }
                    })
                    Mesh.all.forEach(mesh => {
                        for (const key in mesh.faces) {
                            const uv = mesh.faces[key].uv;

                            for (const vkey in uv) {
                                uv[vkey][0] *= texture_width / Project.texture_width;
                                uv[vkey][1] *= texture_height / Project.texture_height;
                            }
                        }
                    })
                }
                // Convert UV mode per element
                if (Project.box_uv != box_uv && ((box_uv && !Cube.all.find(cube => cube['box_uv'])) || (!box_uv && !Cube.all.find(cube => !cube['box_uv'])))) {
                    if (!save)
                        save = Undo.initEdit({elements: Cube.all, uv_only: true, uv_mode: true} as UndoAspects);

                    Cube.all.forEach(cube => cube.setUVMode(box_uv));
                }

                if (!save)
                    save = Undo.initEdit({uv_mode: true});

                Project.texture_width = texture_width;
                Project.texture_height = texture_height;

                if (Format.optional_box_uv)
                    Project.box_uv = box_uv;

                Canvas.updateAllUVs();
                updateSelection();
            }

            const properties = ModelProject['properties'];

            for (const key in properties) {
                properties[key].merge(Project, formResult);
            }

            Project.name = Project.name.trim();
            Project.model_identifier = Project.model_identifier.trim();

            if (save)
                Undo.finishEdit('Change project UV settings');

            Blockbench.dispatchEvent('update_project_settings', formResult);
            BARS.updateConditions();

            if (Project.EditSession) {
                const metadata = {
                    texture_width: Project.texture_width,
                    texture_height: Project.texture_height,
                    box_uv: Project.box_uv
                };

                for (const key in properties) {
                    properties[key].copy(Project, metadata);
                }

                Project.EditSession.sendAll('change_project_meta', JSON.stringify(metadata));
            }

            const modelType = GeckoModelType[formResult[PROPERTY_MODEL_TYPE]]
            Project[PROPERTY_MODEL_TYPE] = modelType;

            if (modelType == GeckoModelType.ITEM)
                Project.parent = 'builtin/entity';

            if (Project.name === Format.name || Project.name === '')
                Project.name = "Strut " + Project[PROPERTY_MODEL_TYPE];

            switch (modelType) {
                case GeckoModelType.ARMOR:
                    if (Outliner.root.length === 0) {
                        Codecs.project.parse(armorTemplate, null);
                    }
                    else {
                        alert('Unable to generate Armor Template over an existing model. Please select Armor on a new or empty project to use this model type.')

                        return false;
                    }
                    break;
                default:
                    break;
            }

            Format.display_mode = modelType === GeckoModelType.ITEM || Boolean(settings[SETTING_ALWAYS_SHOW_DISPLAY].value);

            dialog.hide();
        },
        onFormChange(formResult) {
            try {
                document.getElementById('model_identifier')['placeholder'] = getObjectIdPlaceholder(formResult)
            }// eslint-disable-next-line no-empty
            catch (ex) {}
        },
    })

    dialog.show()

    return true;
}

/**
 * Export the item display json
 * <p>
 * Only called for GeckoLib projects
 */
export function buildDisplaySettingsJson(options = {}) {
    if (!Project)
        return;

    const modelProperties: any = {}

    if (options['comment'] || settings.credit.value)
        modelProperties.credit = settings.credit.value

    if (options['parent'] || Project.parent != '')
        modelProperties.parent = Project.parent

    if (options['ambientocclusion'] || Project.ambientocclusion === false)
        modelProperties.ambientocclusion = false

    if (Project.texture_width !== 16 || Project.texture_height !== 16)
        modelProperties.texture_size = [Project.texture_width, Project.texture_height]

    if (options['front_gui_light'] || Project.front_gui_light)
        modelProperties.gui_light = 'front';

    if (options['overrides'] || Project.overrides)
        modelProperties.overrides = Project.overrides;

    if (options['display'] || !isEmpty(Project.display_settings)) {
        const nonDefaultDisplays = {}

        for (const slot in DisplayMode.slots) {
            const perspective = DisplayMode.slots[slot]
            // eslint-disable-next-line no-prototype-builtins
            if (DisplayMode.slots.hasOwnProperty(slot) && Project.display_settings[perspective]) {
                const display: any = Project.display_settings[perspective].export();

                if (display)
                    nonDefaultDisplays[perspective] = display
            }

        }

        if (!isEmpty(nonDefaultDisplays))
            modelProperties.display = nonDefaultDisplays
    }

    if (options['textures'] || !isEmpty(Project.textures)) {
        for (const texture of Project.textures) {
            if (texture.particle || (settings[SETTING_AUTO_PARTICLE_TEXTURE].value && Object.keys(Project.textures).length === 1)) {
                let name = texture.name;

                if (name.indexOf(".png") > 0)
                    name = name.substring(0, name.indexOf(".png"))

                if (!isValidPath(name)) {
                    name = name.toLowerCase().replace(" ", "_")

                    if (!isValidPath(name))
                        continue;
                }

                name = (Project[PROPERTY_MODEL_TYPE] == GeckoModelType.BLOCK ? "block/" : "item/") + name;

                if (Project[PROPERTY_MODID])
                    name = Project[PROPERTY_MODID] + ":" + name

                modelProperties.textures = {'particle': name};

                break
            }
        }
    }

    Blockbench.export({
        resource_id: 'model',
        type: Codecs.java_block.name,
        extensions: ['json'],
        name: Project.model_identifier ? (Project.model_identifier + ".json") : codec.fileName().replace(".geo", ""),
        startpath: Project[PROPERTY_FILEPATH_CACHE].display,
        content: JSON.stringify(modelProperties, null, 2),
    }, file_path => {
        const oldPath = Project[PROPERTY_FILEPATH_CACHE].display;
        Project[PROPERTY_FILEPATH_CACHE].display = settings[SETTING_REMEMBER_EXPORT_LOCATIONS].value ? file_path : undefined;

        if (oldPath !== Project[PROPERTY_FILEPATH_CACHE].display)
            Project.saved = false;
    });

    return this;
}

export default codec;