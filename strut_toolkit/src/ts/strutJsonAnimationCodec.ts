import { monkeypatchAnimatorLoadFile } from './events';

/**
 * A real {@code AnimationCodec}, attached as {@code format.animation_codec}, whose entire reason
 * to exist is fixing GeckoLib `.animation.json` import - not introducing a new format
 * <p>
 * Live-verified against a real Blockbench 5.1.6 session (not inferred from typed declarations):
 * the "Import Animations" panel button does not call {@code Animator.loadFile} - the function
 * {@code monkeypatchAnimatorLoadFile} in `events.ts` patches - at all any more. It dispatches
 * through {@code AnimationCodec.getCodec()}, which silently falls back to Blockbench's own
 * generic, built-in `bedrock` codec whenever a format (like Strut, which never attached one)
 * declares no `animation_codec` of its own. That generic codec has no concept of `easing` or
 * `GeckolibBoneAnimator`, and empirically produces zeroed-out keyframe values for perfectly
 * ordinary multi-keyframe GeckoLib channels - not a subtle edge case, every imported keyframe
 * past the constructor defaults read 0 for every axis. `Animator.loadFile`'s own monkeypatch has
 * therefore been dead code from this specific button's perspective for as long as Blockbench has
 * used this dispatch mechanism, predating this plugin's fork phase 6 work entirely
 * <p>
 * Export is a different story, confirmed by the same live session: the generic `bedrock` codec's
 * own `compileFile()` already preserves `easing` correctly for a probed keyframe, because it (like
 * `Animator.buildFile` before Blockbench's own dispatch migration) still calls each keyframe's own
 * `compileBedrockKeyframe()` method - the one this plugin's `keyframeExtend` in `keyframe.ts`
 * monkeypatches at the per-keyframe level, independent of which top-level function orchestrates
 * the compile. So export already works via the generic codec; only import needed fixing. Every
 * other capability (`compileFile`, `exportFile`, `saveAnimation`, etc.) is forwarded straight
 * through to the real `bedrock` codec's own implementation rather than reimplemented, to avoid
 * regressing anything this investigation didn't touch
 */
export function createStrutJsonAnimationCodec(): AnimationCodec {
    const bedrock = AnimationCodec.codecs.bedrock as any;
    const forwarded: Record<string, unknown> = {};

    for (const key of ['compileFile', 'exportFile', 'reloadFile', 'deleteAnimationFromFile',
        'compileAnimation', 'saveAnimation', 'reloadAnimation']) {
        if (typeof bedrock[key] === 'function') {
            forwarded[key] = (...args: unknown[]) => bedrock[key](...args);
        }
    }

    return new AnimationCodec('strut_json_animation', {
        ...forwarded,
        multiple_per_file: true,
        pickFile() {
            (Blockbench as any).import({
                resource_id: 'strut_animation_json',
                type: 'JSON Animation',
                extensions: ['json'],
                readtype: 'text',
                multiple: true,
            }, (files: any[]) => {
                for (const file of files) {
                    (this as any).importFile(file);
                }
            });
        },
        importFile(file: any) {
            return (this as any).loadFile(file);
        },
        loadFile(file: any, animation_filter?: string[]) {
            return monkeypatchAnimatorLoadFile(file, animation_filter);
        },
    } as any);
}
