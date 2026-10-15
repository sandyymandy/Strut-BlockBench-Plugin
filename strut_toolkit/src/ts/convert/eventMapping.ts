import { EVENT_KIND_INSTRUCTION, EVENT_KIND_SOUND, RawEvent } from '../binary/animation';
import { EventMapper, LegacyEvent } from './animationToRaw';

/**
 * What a legacy animation event becomes in the new system, and the binding files that make it do something (AI Info/CONVERTER_PLAN.md section 9)
 * <p>
 * Pleasure Horizons' rule, from its own tables: <b>every token of a cue becomes a marker, verbatim</b>, and the sounds and messages its registry
 * ({@code keyframe_events/<girl>.json}) defines become bindings on those markers. Pure: no file access; the command line reads and writes the files
 */

/** A marker name may use letters, digits and {@code _ . / -} (the same grammar {@code EventLine} accepts for a bare marker) */
export const MARKER_GRAMMAR = /^[A-Za-z0-9_./-]+$/;

/**
 * A legacy effect string as separate tokens: lower-cased, split on commas and whitespace, empty pieces dropped. A hyphen stays inside a token
 * (PH splits messages on it itself). Nothing is renamed, deduplicated or reordered
 */
export function splitCueTokens(effect: string): string[] {
    return effect.toLowerCase().split(/[\s,]+/).filter(token => token !== '');
}

/** What to do with one cue, when the person overrides the suggestion (a marker with no change is the default and needs no rule) */
export type CueAction = 'marker' | 'sound' | 'custom' | 'leave-out';
export type CueAuthority = 'default' | 'server' | 'client' | 'both';

export interface CueRule {
    readonly action: CueAction;
    /** {@code sound}: the sound id or binding key (default: the cue itself). {@code custom}: the event line, such as {@code pleasurehorizons:fade 1.5} */
    readonly value?: string;
    /** Where it runs; {@code default} lets the event type decide */
    readonly authority?: CueAuthority;
}

/** Keyed by the lower-cased cue token */
export type CueMapping = Readonly<Record<string, CueRule>>;

export const AUTHORITY_BYTE: Record<CueAuthority, number> = { default: 0, server: 1, client: 2, both: 3 };

export interface MarkerMapperOptions {
    /** Called once per token found, whatever is done with it, so the caller can list every cue */
    readonly onCue?: (token: string, event: LegacyEvent) => void;
    /** Called once per token written as a marker, so the caller can build the binding files */
    readonly onToken?: (token: string, event: LegacyEvent) => void;
    readonly rules?: CueMapping;
}

/** A rule that cannot be applied, in plain words, or null */
export function ruleProblem(token: string, rule: CueRule): string | null {
    if (rule.action === 'custom' && (rule.value === undefined || rule.value.trim() === ''))
        return `the cue "${token}" is set to a custom event but has no event line (for example pleasurehorizons:fade 1.5)`;

    if (rule.action === 'custom' && !/^[a-z0-9_.-]+:[a-z0-9_./-]+/.test(rule.value!.trim()))
        return `the custom event "${rule.value}" for the cue "${token}" should start with a namespaced type such as pleasurehorizons:fade`;

    if (rule.action === 'sound' && rule.value !== undefined && rule.value.trim() !== '' && !/^[A-Za-z0-9_.:/-]+$/.test(rule.value.trim()))
        return `the sound "${rule.value}" for the cue "${token}" may only use letters, digits and _ . : / -`;

    return null;
}

/**
 * Sound cues become one marker per token, as {@code instruction} events (a bare word is {@code strut:marker}), unless the person gave that token a rule. Particle and
 * instruction events pass through unchanged. A token outside the marker grammar is reported and skipped, never written
 */
export function markerEventMapper(options: MarkerMapperOptions = {}): EventMapper {
    return (event, report) => {
        if (event.kind !== EVENT_KIND_SOUND)
            return [{ time: event.time, kind: event.kind, payload: event.payload, authority: 0 }];

        const events: RawEvent[] = [];

        for (const token of splitCueTokens(event.payload)) {
            if (!MARKER_GRAMMAR.test(token)) {
                report('lossy', `the cue token "${token}" is not a valid marker name (letters, digits, _ . / - only); skipped`);

                continue;
            }

            options.onCue?.(token, event);

            const rule = options.rules?.[token];
            const authority = AUTHORITY_BYTE[rule?.authority ?? 'default'];

            if (rule === undefined || rule.action === 'marker') {
                options.onToken?.(token, event);
                events.push({ time: event.time, kind: EVENT_KIND_INSTRUCTION, payload: token, authority });

                continue;
            }

            const problem = ruleProblem(token, rule);

            if (problem !== null) {
                report('lossy', `${problem}; the cue is left out`);

                continue;
            }

            if (rule.action === 'leave-out')
                continue;

            if (rule.action === 'sound')
                events.push({ time: event.time, kind: EVENT_KIND_SOUND, payload: (rule.value ?? '').trim() || token, authority });
            else
                events.push({ time: event.time, kind: EVENT_KIND_INSTRUCTION, payload: (rule.value as string).trim(), authority });
        }

        return events;
    };
}

// ---------------------------------------------------------------------------------------------
// The registry: keyframe_events/<girl>.json
// ---------------------------------------------------------------------------------------------

export interface RegistryEntry {
    /** Lower-cased */
    readonly key: string;
    readonly sounds: readonly string[];
    readonly randomSounds: readonly string[];
    /** The texts stay in PH's files; only whether the key has any matters here */
    readonly hasMessage: boolean;
    readonly hasPlayerMessage: boolean;
}

export interface GirlRegistry {
    readonly girlId: string;
    readonly file: string;
    readonly entries: ReadonlyMap<string, RegistryEntry>;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseKeyframeEvents(json: unknown, file: string): GirlRegistry {
    const girlId = typeof (json as any)?.girl_id === 'string' ? (json as any).girl_id : file.replace(/\.json$/, '');
    const entries = new Map<string, RegistryEntry>();

    for (const entry of Array.isArray((json as any)?.events) ? (json as any).events : []) {
        if (typeof entry?.key !== 'string')
            continue;

        const key = entry.key.toLowerCase();

        entries.set(key, {
            key,
            sounds: strings(entry.sounds),
            randomSounds: strings(entry.random_sounds),
            hasMessage: strings(entry.messages).length > 0,
            hasPlayerMessage: strings(entry.player_messages).length > 0,
        });
    }

    return { girlId, file, entries };
}

export interface BindingSet {
    readonly bindings: Record<string, Record<string, string[]>>;
}

/** The action key PH registers for a girl's chat message, and for the player's */
export const MESSAGES_ACTION = 'pleasurehorizons:messages';
export const PLAYER_MESSAGES_ACTION = 'pleasurehorizons:player_messages';

/**
 * One girl's binding file for the tokens the animations actually use, and only those that her registry defines something for:
 * <ul>
 * <li>a token equal to one of her {@code sounds} / {@code random_sounds} keys gets those sounds</li>
 * <li>a token with a hyphen part equal to one of her message keys gets {@code pleasurehorizons:messages: [that key]}</li>
 * <li>a token equal to one of her player-message keys gets {@code pleasurehorizons:player_messages: [that key]}</li>
 * </ul>
 * Dead entries (a key no animation uses) and inert markers (a token with no entry) produce nothing
 */
export function bindingSetFor(girl: GirlRegistry, tokens: Iterable<string>): BindingSet {
    const bindings: Record<string, Record<string, string[]>> = {};

    for (const token of [...new Set(tokens)].sort()) {
        const binding: Record<string, string[]> = {};
        const own = girl.entries.get(token);

        if (own !== undefined && own.sounds.length > 0)
            binding.sounds = [...own.sounds];

        if (own !== undefined && own.randomSounds.length > 0)
            binding.random_sounds = [...own.randomSounds];

        const messageKeys = token.split('-').filter(part => girl.entries.get(part)?.hasMessage === true);

        if (messageKeys.length > 0)
            binding[MESSAGES_ACTION] = messageKeys;

        if (own !== undefined && own.hasPlayerMessage)
            binding[PLAYER_MESSAGES_ACTION] = [token];

        if (Object.keys(binding).length > 0)
            bindings[token] = binding;
    }

    return { bindings };
}

// ---------------------------------------------------------------------------------------------
// Tags: what a token is, for the report and the GUI (informational; nothing is dropped)
// ---------------------------------------------------------------------------------------------

export type Tag = 'gameplay' | 'ui' | 'message/sound' | 'no consumer' | 'inert';

const GAMEPLAY = ['thrust', 'cumflate', 'switch', 'reset', 'ready', 'rapid', 'becomenude', 'swap', 'paizuri_startstep'];
const UI = ['sexui', 'blackscreen'];
const NO_CONSUMER = ['drawitems', 'removeitems', 'renderegg', 'paymentdone', 'attackdone', 'attacksound', 'resetcumpercentage', 'startstrip',
    'stripdone', 'carry_introcam', 'boobjob_camera'];

/** PH's own table: gameplay and UI cues are found by {@code contains}, which is why a token is tagged by what it contains */
export function classifyToken(token: string, registries: readonly GirlRegistry[]): Tag {
    if (GAMEPLAY.some(name => token.includes(name)))
        return 'gameplay';

    if (UI.some(name => token.includes(name)))
        return 'ui';

    for (const girl of registries) {
        const own = girl.entries.get(token);

        if (own !== undefined && (own.sounds.length > 0 || own.randomSounds.length > 0 || own.hasPlayerMessage))
            return 'message/sound';

        if (token.split('-').some(part => girl.entries.get(part)?.hasMessage === true))
            return 'message/sound';
    }

    if (NO_CONSUMER.some(name => token.includes(name)))
        return 'no consumer';

    return 'inert';
}
