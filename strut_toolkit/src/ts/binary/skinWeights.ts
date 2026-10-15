import { RawInfluence, MAX_INFLUENCES } from './model';

/**
 * Cap a vertex's raw candidate influences at {@link MAX_INFLUENCES}, breaking ties deterministically
 * by bone index, then renormalise the survivors to sum to 1
 * <p>
 * Pulled out of `strutCodec.ts` into its own dependency-free module for the same reason
 * `cubeUv.ts` was in fork phase 6 stage 3 - this is the one piece of stage 4's skin export that
 * has no Blockbench object in it at all, so there's no reason to leave it untestable alongside
 * the parts that genuinely can't be (see `docs/BINARY_CODEC_PLAN.md` §4)
 */
export function normalizeInfluences(raw: readonly RawInfluence[]): RawInfluence[] {
    const sorted = [...raw].sort((a, b) => b.weight - a.weight || a.boneIndex - b.boneIndex);
    const capped = sorted.slice(0, MAX_INFLUENCES);
    const sum = capped.reduce((total, influence) => total + influence.weight, 0);

    return sum > 0
        ? capped.map(influence => ({ boneIndex: influence.boneIndex, weight: influence.weight / sum }))
        : [];
}
