import {
    buildWearerProfile, coversBySlot, groupsOfSlot, isArmourSlot, MarkedGroup, setFileSlots, slotModelName, slotsWithArmour,
} from '../ts/armourProfile';

const groups: MarkedGroup[] = [
    { name: 'armorHelmet', slot: 'head', covers: '' },
    { name: 'armorChest', slot: 'chest', covers: '' },
    { name: 'armorShoulderL', slot: 'chest', covers: '' },
    { name: 'boobL', slot: '', covers: 'chest' },
    { name: 'boobR', slot: '', covers: 'chest' },
    { name: 'vagina', slot: '', covers: 'legs' },
    { name: 'armorPantsUpL', slot: 'legs', covers: '' },
    { name: 'eyes', slot: '', covers: '' },
];

describe('armour marks', () => {
    test('slots with armour come in export order and only the ones with a group', () => {
        expect(slotsWithArmour(groups)).toEqual(['head', 'chest', 'legs']);
    });

    test('the groups of a slot are the ones marked for it', () => {
        expect(groupsOfSlot(groups, 'chest')).toEqual(['armorChest', 'armorShoulderL']);
        expect(groupsOfSlot(groups, 'feet')).toEqual([]);
    });

    test('what a slot covers is gathered by slot', () => {
        expect(coversBySlot(groups)).toEqual({ chest: ['boobL', 'boobR'], legs: ['vagina'] });
    });

    test('only the game\'s slots are slots', () => {
        expect(isArmourSlot('head')).toBe(true);
        expect(isArmourSlot('cape')).toBe(false);
        expect(isArmourSlot('')).toBe(false);
    });
});

describe('wearer profile', () => {
    test('names the set and what each slot hides', () => {
        expect(JSON.parse(buildWearerProfile('mymod:girl', groups))).toEqual({
            armour_set: 'mymod:girl',
            slots: { chest: { covers: ['boobL', 'boobR'] }, legs: { covers: ['vagina'] } },
        });
    });

    test('leaves the set out when there is none, for a profile that extends another', () => {
        expect(JSON.parse(buildWearerProfile('  ', groups)).armour_set).toBeUndefined();
    });

    test('a project with no covers has no slots', () => {
        expect(JSON.parse(buildWearerProfile('mymod:girl', [{ name: 'a', slot: 'head', covers: '' }]))).toEqual({ armour_set: 'mymod:girl' });
    });
});

describe('slot file names', () => {
    test('a model name for a slot comes from the set', () => {
        expect(slotModelName('mymod:girl', 'head')).toBe('girl_head');
        expect(slotModelName('mymod:races/elf', 'feet')).toBe('elf_feet');
        expect(slotModelName('girl', 'legs')).toBe('girl_legs');
    });

    test('the set file lists the models by id', () => {
        expect(setFileSlots('mymod:girl', ['head', 'chest'])).toEqual({ head: 'mymod:armour/girl_head', chest: 'mymod:armour/girl_chest' });
    });
});
