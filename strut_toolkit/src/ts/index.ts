import semverCoerce from 'semver/functions/coerce';
import semverSatisfies from 'semver/functions/satisfies';
import packageJson from '../package.json';
import { loadAnimationUI, unloadAnimationUI } from './animationUi';
import {hasModelDisplaySettings, isEmpty, isGeckoLibModel, isValidNamespace, make} from './utils';
import { loadKeyframeOverrides, unloadKeyframeOverrides } from './keyframe';
import {buildDisplaySettingsJson, format} from './codec';
import {exportBinaryModel, importBinaryModel} from './strutCodec';
import {exportSelectedSlot} from './armourUi';
import {exportBinaryAnimations, importBinaryAnimations} from './strutAnimationCodec';
import {createStrutJsonAnimationCodec} from './strutJsonAnimationCodec';
import {
    GeckoFilepathCache,
    STRUT_MODEL_ID, LEGACY_MODEL_ID,
    GeckoModelType, PROPERTY_FILEPATH_CACHE, PROPERTY_MODEL_TYPE, PROPERTY_MODID, PROPERTY_PHYSICS,
    SETTING_ALWAYS_SHOW_DISPLAY, SETTING_AUTO_PARTICLE_TEXTURE, BAKE_IN_BEZIER_KEYFRAMES,
    SETTING_DEFAULT_MODID,
    SETTING_REMEMBER_EXPORT_LOCATIONS,
} from "./constants";
import {addEventListeners, removeEventListeners} from "./events";
import {openPhysicsDialog} from './physicsUi';
import {loadPhysicsTab, unloadPhysicsTab} from './physicsTab';
import {loadArmaturePasteFix, unloadArmaturePasteFix} from './armaturePasteFix';
import {createArmourMenuItems, createArmourProperties} from './armourUi';

const { version, blockbenchConfig } = packageJson;

const SUPPORTED_BB_VERSION_RANGE = `>=${blockbenchConfig.min_version}`;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const css = require('../resources/easing_keyframes.css').toString();

if (!semverSatisfies(semverCoerce(Blockbench.version), SUPPORTED_BB_VERSION_RANGE))
  alert(`Strut Toolkit currently only supports Blockbench ${SUPPORTED_BB_VERSION_RANGE}. Please ensure you are using this version of Blockbench to avoid bugs and undefined behavior.`);

// Register the plugin and define what it adds
(function () {
  let pluginSettings: Setting[];
  let pluginProperties: Property[];
  let pluginMenuItems: { action: Action, menuCategory: string }[];

  BBPlugin.register("strut_toolkit", Object.assign(
      {},
      blockbenchConfig as typeof blockbenchConfig & { variant: 'both' },
      {
        name: blockbenchConfig.title,
        version,
        await_loading: true,
        onload() {
          Blockbench.addCSS(css);

          addEventListeners();
          loadAnimationUI();
          loadKeyframeOverrides();
          loadPhysicsTab();
          loadArmaturePasteFix();

          // Fixes GeckoLib .animation.json import - live-verified that Blockbench's own "Import
          // Animations" panel button dispatches through AnimationCodec.getCodec(), which falls
          // back to Blockbench's generic, GeckoLib-unaware `bedrock` codec whenever a format (like
          // Strut, until now) has none of its own. See strutJsonAnimationCodec.ts's own top
          // comment for the full investigation
          format.animation_codec = createStrutJsonAnimationCodec();

          pluginSettings = createPluginSettings();
          pluginProperties = [...createPluginProperties(), ...createArmourProperties()];
          pluginMenuItems = [...createPluginMenuItems(), ...createArmourMenuItems()];

          for (const menuItem of pluginMenuItems as { action: Action, menuCategory: string }[]) {
            MenuBar.addAction(menuItem.action, menuItem.menuCategory);
          }

          console.log("Loaded Strut Toolkit plugin")
        },
        onunload() {
          for (const setting of pluginSettings) {
            setting.delete();
          }

          for (const property of pluginProperties) {
            property.delete();
          }

          for (const menuItem of pluginMenuItems) {
            menuItem.action.delete();
          }

          unloadArmaturePasteFix();
          unloadPhysicsTab();
          unloadKeyframeOverrides();
          unloadAnimationUI();
          removeEventListeners()

          if (format.animation_codec) {
            delete (AnimationCodec as any).codecs[(format.animation_codec as any).id];
            format.animation_codec = undefined;
          }

          format.delete();
          delete Formats[LEGACY_MODEL_ID];
          console.clear();
        },
      }
  ));
})();

/**
 * Create and return the plugin's settings.
 * <p>
 * These are found in the Settings panel in the plugin info window
 */
function createPluginSettings(): Setting[] {
  return [
    new Setting(SETTING_AUTO_PARTICLE_TEXTURE, {
      value: true,
      category: "export",
      name: "Auto-compute block/item particle texture",
      description: "Attempt to auto-compute the particle texture for a Strut block/item model if one isn't already specified when exporting the display settings json"
    }),
    new Setting(BAKE_IN_BEZIER_KEYFRAMES, {
      value: false,
      category: "export",
      name: "Bake in bezier keyframes",
      description: "When true Blockbench makes a ton of linear keyframes to form the illusion of a bezier easing, rather than properly setting the easing to bezier."
    }),
    new Setting(SETTING_ALWAYS_SHOW_DISPLAY, {
      value: false,
      category: "edit",
      name: "Always show display tab",
      description: "Force the Display tab to always show, even when not an Item type model"
    }),
    new Setting(SETTING_REMEMBER_EXPORT_LOCATIONS, {
      value: true,
      category: "export",
      name: "Remember file export locations",
      description: "Remember where you export model/display/animation files to for re-use. Stores the file paths in the bbmodel project file."
    }),
    make(
        new Setting(SETTING_DEFAULT_MODID, {
          // The below is absolutely disgusting, but I have no choice because this is a bug in Blockbench's API
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          type: 'text',
          value: "",
          category: "export",
          name: "Default Mod ID",
          description: "Default Mod ID for models (if applicable)"
        }),
        setting => {
          setting.onChange = function() {
            const invalidNamespaceChar = new RegExp('[^_\\-.a-z0-9]+', 'g')
            const pseudoWhitepaceChar = new RegExp('[\\s&-]+', 'g')

            this.master_value = this.master_value.toLowerCase().replace(pseudoWhitepaceChar, "_").replace(invalidNamespaceChar, "")

            return {};
          }
        }
    )
  ];
}

/**
 * Create and return the plugin's properties.
 * <p>
 * These are metadata values stored in the project, usually used in project settings windows
 */
function createPluginProperties(): Property[] {
  return [
      make(
          new Property(ModelProject, "string", PROPERTY_MODID, {
              label: "Mod ID",
              condition: {
                  formats: [STRUT_MODEL_ID]
              },
              values: [],
              merge_validation: isValidNamespace
          }),
          property => {
            property['placeholder'] = 'my_modid';
            property['description'] = 'The modid of the mod this model is for';
            property.getDefault = function() {
              return String(settings[SETTING_DEFAULT_MODID].value);
            };
          }
      ),
      make(
          new Property(ModelProject, "enum", PROPERTY_MODEL_TYPE, {
              label: "Model Type",
              condition: {
                  formats: [STRUT_MODEL_ID]
              },
              exposed: false,
              options: GeckoModelType,
              values: Object.values(GeckoModelType)
          }),
          property => {
            property['description'] = 'The type of Strut object this model is for. Leave as the default value if unsure';
          }
      ),
      make(
          new Property(ModelProject, "string", PROPERTY_PHYSICS, {
              label: "Strut Physics",
              condition: {
                  formats: [STRUT_MODEL_ID]
              },
              exposed: false,
              values: []
          }),
          property => {
              property['description'] = 'The physics of the model as JSON (edit it under Tools, Strut Physics)';
          }
      ),
      make(
          new Property(ModelProject, "instance", PROPERTY_FILEPATH_CACHE, {
              label: "Strut Filepath Cache",
              condition: {
                  formats: [STRUT_MODEL_ID]
              },
              exposed: false,
              values: []
          }),
          property => {
              property.default = {} as GeckoFilepathCache;
          }
      )
  ];
}

/**
 * Create and return the plugin's menu items
 * <p>
 * These are added to Blockbench's menu bar or submenus
 */
function createPluginMenuItems(): { action: Action, menuCategory: string }[] {
  return [
    {
      // Fork phase 6 stage 6: JSON model export is retired now that the binary round-trip gate
      // is green (docs/BINARY_CODEC_PLAN.md §0/§6) - the former "Export Strut Model" (JSON)
      // action, which called codec.export() (Codecs.bedrock's own JSON geometry writer), is gone
      action: new Action("export_strut_binary_model", {
        name: "Export Strut Model (Binary)",
        icon: "save",
        description: "Export your model geometry as a .strutmodel binary file for Strut.",
        category: "file",
        condition: () => isGeckoLibModel(),
        click: function () {
          exportBinaryModel();
        },
      }),
      menuCategory: 'file.export'
    },
    {
      action: new Action("export_strut_armour_slot", {
        name: "Export Armour Slot Model (Binary)",
        icon: "shield",
        description: "Select the bones (groups) that hold an armour piece in the outliner first, then pick its slot: exports only their geometry, on top of the bones above them, so it is worn by bone name.",
        category: "file",
        condition: () => isGeckoLibModel(),
        click: function () {
          exportSelectedSlot();
        },
      }),
      menuCategory: 'file.export'
    },
    {
      // Opens a new project from a .strutmodel - not gated on isGeckoLibModel() since this
      // creates its own new project rather than acting on whatever is already open
      action: new Action("import_strut_binary_model", {
        name: "Import Strut Model (Binary)",
        icon: "file_open",
        description: "Open a .strutmodel binary file as a new Strut project.",
        category: "file",
        click: function () {
          importBinaryModel();
        },
      }),
      menuCategory: 'file.import'
    },
    {
      action: new Action("export_geckolib_display", {
        name: "Export Strut Display Settings",
        icon: "icon-bb_interface",
        description: "Export your item/block display settings for Strut.",
        category: "file",
        condition: () => isGeckoLibModel() && hasModelDisplaySettings(),
        click: buildDisplaySettingsJson,
      }),
      menuCategory: 'file.export'
    },
    {
      // Fork phase 6 stage 6: this plugin's own "Export Strut Animations" (JSON) action is
      // retired the same way the model one is. Note the scope of that: it only removes this
      // plugin's own dedicated shortcut, which used to trigger Blockbench's built-in
      // "Export Animation" bar item (BarItems.export_animation_file) on the user's behalf. That
      // bar item is generic, native Blockbench UI, not something this plugin registers or can
      // cleanly disable - it stays reachable through Blockbench's own menus regardless, still
      // running through Animator.buildFile and this plugin's existing monkeypatch on it
      // (monkeypatchAnimatorBuildFile in events.ts). That machinery (the bezier "strut_bezier"
      // sentinel swap, strut_format_version) is therefore NOT dead weight, despite what this
      // plan originally hoped - see docs/BINARY_CODEC_PLAN.md §6 stage 6's note
      //
      // Deliberately not wired through an AnimationCodec; see strutAnimationCodec.ts's own top
      // comment for why
      action: new Action("export_strut_binary_animations", {
        name: "Export Strut Animations (Binary)",
        icon: "save",
        description: "Export your model animations as a .strutanim binary file for Strut.",
        category: "file",
        condition: () => isGeckoLibModel() && !isEmpty(AnimationItem.all),
        click: function () {
          exportBinaryAnimations();
        },
      }),
      menuCategory: 'file.export'
    },
    {
      action: new Action("strut_physics_settings", {
        name: "Physics as JSON (advanced)...",
        icon: "waves",
        description: "Edit the model's physics as JSON, check it and preview the response curves. The Physics tab is the visual way.",
        category: "edit",
        condition: () => isGeckoLibModel(),
        click: function () {
          openPhysicsDialog();
        },
      }),
      menuCategory: 'tools'
    },
    {
      // Imports into the current project, unlike model import - an animation only makes sense
      // against an existing rig
      action: new Action("import_strut_binary_animations", {
        name: "Import Strut Animations (Binary)",
        icon: "movie",
        description: "Import a .strutanim binary file's animations into the current project.",
        category: "file",
        condition: () => isGeckoLibModel(),
        click: function () {
          importBinaryAnimations();
        },
      }),
      menuCategory: 'file.import'
    }
  ];
}
