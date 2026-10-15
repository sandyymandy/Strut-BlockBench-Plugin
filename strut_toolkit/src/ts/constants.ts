/**
 * Strut plugin model format ID. Used to identify model types generated from this plugin
 * <p>
 * A new id, not the {@link LEGACY_MODEL_ID} this plugin forked from - see
 * {@code docs/PLUGIN_PORT_PLAN.md} §4 for why: a distinct id is what lets Strut and a GeckoLib
 * plugin be installed side by side. A project saved under the legacy id still opens directly as
 * Strut - see {@link LEGACY_MODEL_ID} - so this is not the "two formats alias each other" shape
 * it might look like; only the legacy id resolves to both, never the reverse
 */
export const STRUT_MODEL_ID = "strut_model"

/**
 * The format id this plugin used before the Strut rebrand (fork phase 5 stage 3)
 * <p>
 * {@code index.ts} registers this as a second key in the global {@code Formats} lookup pointing
 * at the same {@link STRUT_MODEL_ID} format object, so a {@code .bbmodel} saved under the old
 * identity - {@code meta.model_format: "animated_entity_model"} - resolves straight to Strut on
 * open, the same way {@code Formats[model.meta.model_format]} resolves any other format (verified
 * against real Blockbench 5.1.6 source's project-open dispatch). {@code Format.id} itself still
 * reads {@code STRUT_MODEL_ID} the instant the project opens; this id only ever appears in an old
 * file's own stored metadata, never as the live active format
 */
export const LEGACY_MODEL_ID = "animated_entity_model"

// Setting name constants
export const SETTING_AUTO_PARTICLE_TEXTURE = 'strut_auto_particle_texture';
export const SETTING_ALWAYS_SHOW_DISPLAY = 'strut_always_show_display';
export const SETTING_REMEMBER_EXPORT_LOCATIONS = 'strut_remember_export_locations';
export const SETTING_DEFAULT_MODID = 'strut_default_modid';
export const BAKE_IN_BEZIER_KEYFRAMES = "strut_bake_in_bezier_keyframes";

// Property name constants
export const PROPERTY_MODID = 'strut_modid';
export const PROPERTY_MODEL_TYPE = 'strut_model_type';
export const PROPERTY_FILEPATH_CACHE = 'strut_filepath_cache';
/** The model's physics text (JSON), written into the model file as its strut_physics:physics section */
export const PROPERTY_PHYSICS = 'strut_physics';

/**
 * The wire keys {@link PROPERTY_MODID}, {@link PROPERTY_MODEL_TYPE} and
 * {@link PROPERTY_FILEPATH_CACHE} replaced. A project saved under {@link LEGACY_MODEL_ID} still
 * has these as raw, unclaimed top-level JSON fields once only Strut's `strut_*`-named
 * `Property`s are registered - nothing merges them onto the new fields automatically, since
 * {@code Property.merge} matches by its own registered name. {@code events.ts}'s
 * {@code onProjectParse} reads them across explicitly, once, for a project opened this way
 */
export const LEGACY_PROPERTY_MODID = 'geckolib_modid';
export const LEGACY_PROPERTY_MODEL_TYPE = 'geckolib_model_type';
export const LEGACY_PROPERTY_FILEPATH_CACHE = 'geckolib_filepath_cache';

/**
 * Available GeckoLib model types
 */
export enum GeckoModelType {
    ENTITY = 'Entity',
    BLOCK = 'Block',
    ITEM = 'Item',
    ARMOR = 'Armor',
    OBJECT = 'Object'
}

/**
 * Statically defined type for the filepath cache property, for ease of use
 */
export type GeckoFilepathCache = {model?: string, animation?: string, display?: string}