/**
 * Armour marks on a wearer project, and the wearer profile and slot file names worked out from them. No Blockbench globals: the live side is `armourUi.ts`
 * <p>
 * Two marks on a group say how the project is armour-ready: {@code strut_armour_slot} (this group holds the armour of that slot: it is exported in that slot's
 * model) and {@code strut_armour_covers} (this group is hidden while that slot is worn: it goes in the wearer profile's {@code covers} of the slot)
 */

export const PROPERTY_ARMOUR_SLOT = 'strut_armour_slot';
export const PROPERTY_ARMOUR_COVERS = 'strut_armour_covers';
export const PROPERTY_ARMOUR_SET = 'strut_armour_set';

/** The slots Strut's armour system has, in the order they are exported */
export const ARMOUR_SLOTS = ['head', 'chest', 'legs', 'feet', 'body'] as const;

export type ArmourSlot = typeof ARMOUR_SLOTS[number];

/** What the marks of one group say */
export interface MarkedGroup {
    name: string;
    /** The slot this group holds the armour of, or '' */
    slot: string;
    /** The slot that hides this group while it is worn, or '' */
    covers: string;
}

/** Whether {@code text} is a slot name */
export function isArmourSlot(text: string): text is ArmourSlot {
    return (ARMOUR_SLOTS as readonly string[]).includes(text);
}

/** The slots that have at least one group marked as holding their armour, in export order */
export function slotsWithArmour(groups: MarkedGroup[]): ArmourSlot[] {
    return ARMOUR_SLOTS.filter(slot => groups.some(group => group.slot === slot));
}

/** The names of the groups marked as holding the armour of {@code slot} */
export function groupsOfSlot(groups: MarkedGroup[], slot: string): string[] {
    return groups.filter(group => group.slot === slot).map(group => group.name);
}

/** The names of the groups hidden while each slot is worn, by slot; only slots that hide something */
export function coversBySlot(groups: MarkedGroup[]): Record<string, string[]> {
    const covers: Record<string, string[]> = {};

    for (const group of groups) {
        if (!isArmourSlot(group.covers))
            continue;

        (covers[group.covers] ??= []).push(group.name);
    }

    return covers;
}

/**
 * The wearer profile file for a project: the armour set it wears and what each slot hides, as the text of
 * {@code assets/<ns>/strut/armour/wearers/<name>.json}
 *
 * @param setId the armour set, {@code <namespace>:<path>}; left out of the file if empty (a profile that extends another)
 */
export function buildWearerProfile(setId: string, groups: MarkedGroup[]): string {
    const profile: { armour_set?: string; slots?: Record<string, { covers: string[] }> } = {};

    if (setId.trim() !== '')
        profile.armour_set = setId.trim();

    const covers = coversBySlot(groups);
    const slots: Record<string, { covers: string[] }> = {};

    for (const slot of ARMOUR_SLOTS)
        if (covers[slot])
            slots[slot] = { covers: covers[slot] };

    if (Object.keys(slots).length > 0)
        profile.slots = slots;

    return JSON.stringify(profile, null, 2) + '\n';
}

/**
 * The model name of a slot's file for a set: {@code mymod:girl} and {@code head} make {@code girl_head}, the file {@code strut/models/armour/girl_head.strutmodel} the
 * set lists as {@code mymod:armour/girl_head}
 */
export function slotModelName(setId: string, slot: string): string {
    const path = setId.includes(':') ? setId.substring(setId.indexOf(':') + 1) : setId;
    const base = path.replace(/[^a-zA-Z0-9_./-]/g, '_').split('/').pop() || 'armour';

    return `${base}_${slot}`;
}

/** The slot entry of the set file for the models {@link slotModelName} names, in the namespace of {@code setId} */
export function setFileSlots(setId: string, slots: ArmourSlot[]): Record<string, string> {
    const namespace = setId.includes(':') ? setId.substring(0, setId.indexOf(':')) : 'minecraft';
    const entries: Record<string, string> = {};

    for (const slot of slots)
        entries[slot] = `${namespace}:armour/${slotModelName(setId, slot)}`;

    return entries;
}
