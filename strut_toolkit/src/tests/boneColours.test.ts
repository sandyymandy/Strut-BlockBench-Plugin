import { BONE_COLOUR_SECTION, decodeBoneColours, elementNameFor, encodeBoneColours, markerOf, storedColour } from '../ts/boneColours';

describe('bone colours', () => {
    test('a marker index is stored plus one, so 0 stays "none"', () => {
        expect(storedColour(0)).toBe(1);
        expect(storedColour(7)).toBe(8);
        expect(storedColour(-1)).toBe(0);
        expect(storedColour(undefined)).toBe(0);
        expect(storedColour('3')).toBe(0);
        expect(markerOf(0)).toBeUndefined();
        expect(markerOf(1)).toBe(0);
        expect(markerOf(8)).toBe(7);
    });

    test('bones with no colour keep no section at all', () => {
        expect(encodeBoneColours([0, 0, 0])).toBeNull();
        expect(encodeBoneColours([])).toBeNull();
    });

    test('colours are runs, and come back as they went', () => {
        const colours = [3, 3, 3, 0, 0, 5, 3, 3];
        const section = encodeBoneColours(colours)!;

        expect(section.length).toBe(4 * 3);
        expect(decodeBoneColours(section, colours.length)).toEqual(colours);
    });

    test('a model of one colour is three bytes whatever its size', () => {
        const colours = new Array(300).fill(2);
        const section = encodeBoneColours(colours)!;

        expect(section.length).toBe(3);
        expect(decodeBoneColours(section, 300)).toEqual(colours);
    });

    test('a run over 16 bits is split and joined again', () => {
        const colours = new Array(70000).fill(4);
        const section = encodeBoneColours(colours)!;

        expect(section.length).toBe(6);
        expect(decodeBoneColours(section, 70000)).toEqual(colours);
    });

    test('a section that does not fit the bones is ignored, not an error', () => {
        const section = encodeBoneColours([1, 1, 1])!;

        expect(decodeBoneColours(section, 5)).toEqual([0, 0, 0, 0, 0]);
        expect(decodeBoneColours(new Uint8Array([1, 2]), 2)).toEqual([0, 0]);
    });

    test('the section has a namespaced name', () => {
        expect(BONE_COLOUR_SECTION).toBe('strut_editor:bone_colours');
    });
});

describe('element names on import', () => {
    test('the numbers that end a bone name are left off', () => {
        expect(elementNameFor('armL')).toBe('armL');
        expect(elementNameFor('boobL2')).toBe('boobL');
        expect(elementNameFor('hair_12')).toBe('hair');
        expect(elementNameFor('hair.003')).toBe('hair');
        expect(elementNameFor('arm2L')).toBe('arm2L');
    });

    test('a name that is only a number is kept whole', () => {
        expect(elementNameFor('12')).toBe('12');
    });
});
