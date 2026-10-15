import {
    PROPERTY_MODID, PROPERTY_MODEL_TYPE, PROPERTY_FILEPATH_CACHE,
    LEGACY_PROPERTY_MODID, LEGACY_PROPERTY_MODEL_TYPE, LEGACY_PROPERTY_FILEPATH_CACHE,
} from './constants';

/**
 * A project saved under this plugin's pre-rebrand identity (see {@code constants.ts}'s
 * {@code LEGACY_MODEL_ID}) still has its per-project metadata under the old {@code geckolib_*}
 * keys. Backfilling the new keys works because {@code events.ts}'s {@code onProjectParse} - the
 * only caller - runs before the shared bbmodel codec's generic per-property merge loop (confirmed
 * against real Blockbench 5.1.6 source), so mutating the raw parsed model in place here is picked
 * up by that merge exactly as if the file had used the new keys from the start. A project already
 * on the new keys is untouched - `??=` only reaches for the legacy key when the new one is absent
 * <p>
 * Kept dependency-free of every Blockbench global (unlike {@code events.ts}, which eagerly
 * references several at module scope through its other imports) so it can be unit tested directly
 * - see {@code tests/migration.test.ts}
 * <p>
 * Keyframe-level {@code easing}/{@code easingArgs} need no equivalent migration - those field
 * names were never prefixed and are unchanged by the rebrand
 */
export function migrateLegacyProjectFields(model: any) {
    model[PROPERTY_MODID] ??= model[LEGACY_PROPERTY_MODID];
    model[PROPERTY_MODEL_TYPE] ??= model[LEGACY_PROPERTY_MODEL_TYPE];
    model[PROPERTY_FILEPATH_CACHE] ??= model[LEGACY_PROPERTY_FILEPATH_CACHE];
}
