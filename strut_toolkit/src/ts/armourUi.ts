import { exportSlotGroups } from './strutCodec';
import { STRUT_MODEL_ID } from './constants';
import { isGeckoLibModel, make } from './utils';
import {
    ARMOUR_SLOTS, buildWearerProfile, isArmourSlot, MarkedGroup, PROPERTY_ARMOUR_COVERS, PROPERTY_ARMOUR_SET, PROPERTY_ARMOUR_SLOT, groupsOfSlot, slotModelName, slotsWithArmour,
} from './armourProfile';

/**
 * The live side of the armour tools: the marks on a group (which slot's armour it holds, which slot hides it), the armour set a wearer project belongs to, and
 * the actions that export a slot model from the marked groups and the wearer profile file from the marks (see `armourProfile.ts` for what they work out)
 */

const SLOT_OPTIONS: Record<string, string> = { '': 'None', ...Object.fromEntries(ARMOUR_SLOTS.map(slot => [slot, slot])) };

/** The properties: two marks on a group, and the set on the project */
export function createArmourProperties(): Property[] {
    const groupMark = (name: string, label: string, description: string): Property => make(
        new (Property as any)(Group, 'enum', name, {
            label,
            default: '',
            values: Object.keys(SLOT_OPTIONS),
            condition: { formats: [STRUT_MODEL_ID] },
            inputs: {
                element_panel: {
                    input: { label, type: 'select', options: SLOT_OPTIONS, description },
                    onChange() { Project.saved = false; },
                },
            },
        }) as Property,
        property => { (property as any).description = description; }
    );

    return [
        groupMark(PROPERTY_ARMOUR_SLOT, 'Armour slot',
            'This group holds the armour of the slot: Export Armour Slot Model exports the groups of one slot as that slot\'s model'),
        groupMark(PROPERTY_ARMOUR_COVERS, 'Hidden by slot',
            'This group is hidden while the slot is worn: it is written into the wearer profile\'s covers of that slot'),
        make(
            new (Property as any)(ModelProject, 'string', PROPERTY_ARMOUR_SET, {
                label: 'Armour set',
                condition: { formats: [STRUT_MODEL_ID] },
                exposed: false,
                values: [],
            }) as Property,
            property => { (property as any).description = 'The armour set this model wears, mymod:creature (a file assets/<ns>/strut/armour/sets/<path>.json)'; }
        ),
    ];
}

/** What the marks on the project's groups say */
function markedGroups(): MarkedGroup[] {
    return ((Group as any).all as any[]).map(group => ({
        name: group.name,
        slot: String(group[PROPERTY_ARMOUR_SLOT] ?? ''),
        covers: String(group[PROPERTY_ARMOUR_COVERS] ?? ''),
    }));
}

/** The armour set of the project, asked for once if it has none yet */
function withArmourSet(then: (setId: string) => void): void {
    const known = String((Project as any)[PROPERTY_ARMOUR_SET] ?? '').trim();

    if (known !== '') {
        then(known);

        return;
    }

    (Blockbench as any).textPrompt('Armour set this model wears (mymod:creature)', 'mymod:creature', (text: string) => {
        (Project as any)[PROPERTY_ARMOUR_SET] = text.trim();
        Project.saved = false;
        then(text.trim());
    });
}

/** Exports the groups marked for {@code slot} as that slot's model, named from the set */
function exportMarkedSlot(slot: string): void {
    const names = new Set(groupsOfSlot(markedGroups(), slot));
    const groups = new Set<any>(((Group as any).all as any[]).filter(group => names.has(group.name) && String(group[PROPERTY_ARMOUR_SLOT] ?? '') === slot));

    if (groups.size === 0) {
        Blockbench.showQuickMessage(`No group is marked as ${slot} armour: set "Armour slot" on the groups of the piece`, 3500);

        return;
    }

    withArmourSet(setId => exportSlotGroups(groups, slotModelName(setId, slot)));
}

/** The slot names as the choice shows them */
const SLOT_CHOICES: Record<string, string> = Object.fromEntries(ARMOUR_SLOTS.map(slot => [slot, slot.charAt(0).toUpperCase() + slot.slice(1)]));

/**
 * Exports the bones (groups) selected in the outliner as the model of a slot the user picks from a list, named from the armour set and the slot so no name is
 * typed. The piece is made on top of the wearer's own skeleton: only the selected bones' geometry is exported, with the bones above them kept empty, so the model
 * is worn by bone name
 */
export function exportSelectedSlot(): void {
    const selected = new Set<any>(((Group as any).all as any[]).filter((group: any) => group.selected));

    if (selected.size === 0) {
        (Blockbench as any).showMessageBox({
            title: 'Select the bones to export',
            message: 'Nothing is selected. Click the bone (group) that holds the armour piece in the outliner first (Ctrl-click to add more: a chestplate is often several), '
                + 'then export again. Only the geometry of the selected bones is exported.',
            buttons: ['OK'],
        });

        return;
    }

    const names = [...selected].map((group: any) => group.name);
    const listed = names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ');
    const known = String((Project as any)[PROPERTY_ARMOUR_SET] ?? '').trim();

    new (Dialog as any)({
        id: 'strut_export_armour_slot',
        title: 'Export armour slot model',
        width: 520,
        form: {
            info: { type: 'info', text: `Exports the ${names.length} selected bone${names.length === 1 ? '' : 's'} (${listed}) and what is on them. To export other bones, cancel, select them in the outliner and export again.` },
            slot: { label: 'Slot', type: 'select', options: SLOT_CHOICES, value: 'head', description: 'The equipment slot this piece is worn in' },
            set: { label: 'Armour set', type: 'text', value: known !== '' ? known : 'mymod:creature', description: 'The armour set this model belongs to, namespace:name (a file assets/<namespace>/strut/armour/sets/<name>.json)' },
        },
        onConfirm(form: any) {
            const slot = String(form.slot);
            const setId = String(form.set ?? '').trim();

            if (!isArmourSlot(slot) || setId === '') {
                Blockbench.showQuickMessage('Choose a slot and give the armour set', 3000);

                return false;
            }

            (Project as any)[PROPERTY_ARMOUR_SET] = setId;
            Project.saved = false;
            exportSlotGroups(selected, slotModelName(setId, slot));
        },
    }).show();
}

/** Writes the wearer profile the marks describe */
function exportWearerProfile(): void {
    withArmourSet(setId => {
        const name = ((Project as any).model_identifier || (Project as any).name || 'wearer') as string;

        Blockbench.export({
            resource_id: 'strut_wearer_profile',
            type: 'Strut Armour Wearer Profile',
            extensions: ['json'],
            name: `${name}.json`,
            content: buildWearerProfile(setId, markedGroups()),
        } as any);
    });
}

/** The menu items: one export for each slot, and the wearer profile */
export function createArmourMenuItems(): { action: Action, menuCategory: string }[] {
    const items: { action: Action, menuCategory: string }[] = ARMOUR_SLOTS.map(slot => ({
        action: new Action(`export_strut_armour_marked_${slot}`, {
            name: `Export Armour Slot Model: ${slot} (marked groups)`,
            icon: 'shield',
            description: `Export the groups marked as ${slot} armour as that slot's model, named from the armour set (no selection needed: the marks say which bones)`,
            category: 'file',
            condition: () => isGeckoLibModel() && slotsWithArmour(markedGroups()).includes(slot),
            click: () => exportMarkedSlot(slot),
        }),
        menuCategory: 'file.export',
    }));

    items.push({
        action: new Action('export_strut_armour_wearer_profile', {
            name: 'Export Armour Wearer Profile (JSON)',
            icon: 'checkroom',
            description: 'Write the wearer profile of this model: its armour set and the groups each slot hides, from the marks on the groups',
            category: 'file',
            condition: () => isGeckoLibModel(),
            click: exportWearerProfile,
        }),
        menuCategory: 'file.export',
    });

    return items;
}
