import { normalizeInfluences } from '../../ts/binary/skinWeights';

/**
 * strutCodec.ts itself can't be imported directly in a jest test (see cubeUv.test.ts's own doc
 * comment), so the cap/tie-break/normalise logic behind fork phase 6 stage 4's skin export lives
 * in its own dependency-free module instead
 */
describe('normalizeInfluences', () => {
    it('renormalises weights that do not already sum to 1', () => {
        expect(normalizeInfluences([{ boneIndex: 0, weight: 0.5 }, { boneIndex: 1, weight: 0.5 }]))
            .toEqual([{ boneIndex: 0, weight: 0.5 }, { boneIndex: 1, weight: 0.5 }]);

        expect(normalizeInfluences([{ boneIndex: 0, weight: 2 }, { boneIndex: 1, weight: 2 }]))
            .toEqual([{ boneIndex: 0, weight: 0.5 }, { boneIndex: 1, weight: 0.5 }]);
    });

    it('sorts by descending weight regardless of input order', () => {
        const result = normalizeInfluences([
            { boneIndex: 2, weight: 0.1 },
            { boneIndex: 0, weight: 0.6 },
            { boneIndex: 1, weight: 0.3 },
        ]);

        expect(result.map(i => i.boneIndex)).toEqual([0, 1, 2]);
        expect(result.map(i => i.weight)[0]).toBeCloseTo(0.6);
        expect(result.map(i => i.weight)[1]).toBeCloseTo(0.3);
        expect(result.map(i => i.weight)[2]).toBeCloseTo(0.1);
    });

    it('caps a vertex authored with five influences to the top four, renormalised', () => {
        const raw = [
            { boneIndex: 0, weight: 0.3 },
            { boneIndex: 1, weight: 0.3 },
            { boneIndex: 2, weight: 0.2 },
            { boneIndex: 3, weight: 0.1 },
            { boneIndex: 4, weight: 0.1 },
        ];

        const result = normalizeInfluences(raw);

        expect(result).toHaveLength(4);
        expect(result.map(i => i.boneIndex)).toEqual([0, 1, 2, 3]);
        expect(result.reduce((sum, i) => sum + i.weight, 0)).toBeCloseTo(1);
    });

    it('breaks a tie at the cutoff deterministically by bone index, not input order', () => {
        // Bones 3 and 4 are tied at the cutoff - bone 3 must win regardless of which one the
        // caller happened to list first
        const raw = [
            { boneIndex: 0, weight: 0.25 },
            { boneIndex: 1, weight: 0.25 },
            { boneIndex: 2, weight: 0.25 },
            { boneIndex: 4, weight: 0.125 },
            { boneIndex: 3, weight: 0.125 },
        ];

        expect(normalizeInfluences(raw).map(i => i.boneIndex)).toEqual([0, 1, 2, 3]);
    });

    it('returns an empty influence list for a vertex with no positive weight', () => {
        expect(normalizeInfluences([])).toEqual([]);
        expect(normalizeInfluences([{ boneIndex: 0, weight: 0 }])).toEqual([]);
    });

    it('leaves a zero-weight candidate in place rather than filtering it - the caller is expected to have done that already', () => {
        const result = normalizeInfluences([
            { boneIndex: 0, weight: 1 },
            { boneIndex: 1, weight: 0 },
        ]);

        expect(result).toEqual([{ boneIndex: 0, weight: 1 }, { boneIndex: 1, weight: 0 }]);
    });
});
