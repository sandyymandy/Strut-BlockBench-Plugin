/**
 * The marker colour of each bone (Blockbench's colour on a group in the outliner), kept in the model file so an export and an import give it back
 * <p>
 * Blockbench has a short fixed list of marker colours, so a colour is one small number. They are stored in an extension section (a reader that does not know
 * it ignores it, so no version moves), as runs: for each stretch of bones in file order with the same colour, the colour and how many bones it covers. A
 * model whose bones are mostly one colour, which is most of them, takes a few bytes. The stored colour is the marker index plus one, so 0 means none (the
 * bone had no colour set, and gets Blockbench's own default on import)
 */
export const BONE_COLOUR_SECTION = 'strut_editor:bone_colours';

/** The most bones a single run covers (a 16-bit count); a longer stretch is several runs */
const MAX_RUN = 0xFFFF;

/** The stored number for a bone's marker colour, which Blockbench gives as an index from 0, or something else (nothing set) */
export function storedColour(marker: unknown): number {
    return typeof marker === 'number' && Number.isInteger(marker) && marker >= 0 && marker < 255 ? marker + 1 : 0;
}

/** The marker index a stored number stands for, or undefined for none */
export function markerOf(stored: number): number | undefined {
    return stored > 0 ? stored - 1 : undefined;
}

/**
 * The section for these stored colours, one for each bone in file order, or null if no bone has one (nothing to keep)
 */
export function encodeBoneColours(colours: readonly number[]): Uint8Array | null {
    if (colours.every(colour => colour === 0))
        return null;

    const out: number[] = [];
    let i = 0;

    while (i < colours.length) {
        const colour = colours[i];
        let run = 1;

        while (i + run < colours.length && colours[i + run] === colour && run < MAX_RUN)
            run++;

        out.push(colour & 0xFF, run & 0xFF, (run >> 8) & 0xFF);
        i += run;
    }

    return Uint8Array.from(out);
}

/**
 * The stored colour of each of {@code count} bones from a section, or all zero (none) for a section that is not a whole number of runs or does not cover the
 * bones: a colour is a convenience, never a reason for a model not to load
 */
export function decodeBoneColours(section: Uint8Array, count: number): number[] {
    const colours = new Array<number>(count).fill(0);

    if (section.length % 3 !== 0)
        return colours;

    let at = 0;

    for (let i = 0; i < section.length; i += 3) {
        const colour = section[i];
        const run = section[i + 1] | (section[i + 2] << 8);

        for (let k = 0; k < run && at < count; k++)
            colours[at++] = colour;
    }

    return at === count ? colours : new Array<number>(count).fill(0);
}

/**
 * What an element is called after being imported: the name of the bone it sits in without the numbers that end it (Blockbench numbers a duplicate name, and
 * elements are allowed to share one), or the bone's name whole if nothing is left of it
 */
export function elementNameFor(boneName: string): string {
    const stripped = boneName.replace(/[\s._-]*\d+$/, '');

    return stripped.length > 0 ? stripped : boneName;
}
