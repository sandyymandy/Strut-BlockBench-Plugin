import { convertAnimationFile } from '../ts/convert/animationToRaw';
import { EVENT_FIELD_SEPARATOR, EVENT_KIND_SOUND } from '../ts/binary/animation';
import { LegacyEvent } from '../ts/convert/animationToRaw';
import {
    bindingSetFor, classifyToken, CueMapping, markerEventMapper, parseKeyframeEvents, ruleProblem, splitCueTokens,
} from '../ts/convert/eventMapping';

/**
 * Stage 4 of the converter (AI Info/CONVERTER_PLAN.md sections 4 and 9): what a legacy cue becomes, and the binding files built from PH's registry
 */
const LUCY = parseKeyframeEvents({
    girl_id: 'lucy',
    events: [
        { key: 'stripMSG1', random_sounds: ['pleasurehorizons:lucy.giggle'], messages: ['Hihi~'] },
        { key: 'paizuriFastMSG1', sounds: ['pleasurehorizons:misc.pounding'], random_sounds: ['pleasurehorizons:lucy.ahh', 'pleasurehorizons:lucy.mmm'] },
        { key: 'bjiMSG8', player_messages: ['Yee'] },
        { key: 'orgasm1', sounds: ['pleasurehorizons:lucy.orgasm'] },
        { key: 'cum', messages: ['Ahh'] },
        { key: 'angry', sounds: ['pleasurehorizons:lucy.angry'] },
        { key: 'empty', sounds: [], random_sounds: [], messages: [], player_messages: [] },
    ],
}, 'lucy.json');

function convertWith(effects: Record<string, unknown>) {
    const tokens: string[] = [];
    const result = convertAnimationFile({ animations: { a: { sound_effects: effects } } }, {
        file: 'x.animation.json',
        mapEvent: markerEventMapper({ onToken: token => tokens.push(token) }),
    });

    return { ...result, tokens };
}

describe('splitCueTokens', () => {
    it('lower-cases, splits on commas and whitespace, drops empty pieces, keeps hyphens and order', () => {
        expect(splitCueTokens('anal_fastMSG1, thrust')).toEqual(['anal_fastmsg1', 'thrust']);
        expect(splitCueTokens('pounding, thrust, switch ')).toEqual(['pounding', 'thrust', 'switch']);
        expect(splitCueTokens('thrust switch')).toEqual(['thrust', 'switch']);
        expect(splitCueTokens('pound-cum-orgasm1')).toEqual(['pound-cum-orgasm1']);
        expect(splitCueTokens('a,,b')).toEqual(['a', 'b']);
        expect(splitCueTokens('thrust, thrust')).toEqual(['thrust', 'thrust']);
    });
});

describe('markerEventMapper', () => {
    it('writes one bare marker (an instruction event) per token, in order, at the same time', () => {
        const { animation, tokens } = convertWith({ '1.5': { effect: 'doggyFastMSG1, thrust' }, '2': { effect: 'sexUI' } });
        const events = animation.clips[0].events;

        expect(events.map(e => [e.time, e.kind, e.payload])).toEqual([
            [1.5, 'instruction', 'doggyfastmsg1'],
            [1.5, 'instruction', 'thrust'],
            [2, 'instruction', 'sexui'],
        ]);
        expect([...tokens].sort()).toEqual(['doggyfastmsg1', 'sexui', 'thrust']);
        expect(animation.strings).toContain('thrust');
    });

    it('writes no sound events at all', () => {
        const { animation } = convertWith({ '0': { effect: 'stripMSG1' } });

        expect(animation.clips[0].events.every(e => e.kind !== 'sound')).toBe(true);
    });

    it('a token outside the marker grammar is reported and skipped, the others in the same cue are kept', () => {
        const { animation, findings } = convertWith({ '0': { effect: "ok, it's bad, fine" } });

        expect(animation.clips[0].events.map(e => e.payload)).toEqual(['ok', 'bad', 'fine']);
        expect(findings.lossy).toBe(1);
        expect(findings.items[0].message).toContain("it's");
        expect(findings.items[0].clip).toBe('a');
    });

    it('particle and instruction events pass through unchanged', () => {
        const { animation } = convertAnimationFile({
            animations: { a: { particle_effects: { '1': { effect: 'minecraft:heart' } }, timeline: { '2': 'pleasurehorizons:fade 1' } } },
        }, { file: 'x', mapEvent: markerEventMapper() });

        expect(animation.clips[0].events.map(e => [e.kind, e.payload])).toEqual([
            ['particle', ['minecraft:heart', '', ''].join(EVENT_FIELD_SEPARATOR)],
            ['instruction', 'pleasurehorizons:fade 1'],
        ]);
    });
});

describe('the registry and the binding sets', () => {
    it('reads keys lower-cased and remembers which have sounds, random sounds, messages and player messages', () => {
        expect(LUCY.girlId).toBe('lucy');
        expect(LUCY.entries.get('stripmsg1')).toMatchObject({ randomSounds: ['pleasurehorizons:lucy.giggle'], hasMessage: true, hasPlayerMessage: false });
        expect(LUCY.entries.get('bjimsg8')?.hasPlayerMessage).toBe(true);
    });

    it('a binding is written only for a token the girl defines something for, with sounds as they are and the message actions carrying the key', () => {
        const set = bindingSetFor(LUCY, ['stripmsg1', 'paizurifastmsg1', 'bjimsg8', 'thrust', 'doggyintromsg1']);

        expect(set.bindings).toEqual({
            bjimsg8: { 'pleasurehorizons:player_messages': ['bjimsg8'] },
            paizurifastmsg1: { sounds: ['pleasurehorizons:misc.pounding'], random_sounds: ['pleasurehorizons:lucy.ahh', 'pleasurehorizons:lucy.mmm'] },
            stripmsg1: { random_sounds: ['pleasurehorizons:lucy.giggle'], 'pleasurehorizons:messages': ['stripmsg1'] },
        });
    });

    it('dead entries (no animation uses them) and entries with nothing defined produce nothing', () => {
        const set = bindingSetFor(LUCY, ['thrust']);

        expect(set.bindings).toEqual({});
        expect(Object.keys(bindingSetFor(LUCY, ['angry', 'empty']).bindings)).toEqual(['angry']);
    });

    it('a message key is found as a hyphen part of a token, a sound key only as the whole token', () => {
        const set = bindingSetFor(LUCY, ['pound-cum-orgasm1']);

        expect(set.bindings).toEqual({ 'pound-cum-orgasm1': { 'pleasurehorizons:messages': ['cum'] } });
        expect(bindingSetFor(LUCY, ['orgasm1']).bindings).toEqual({ orgasm1: { sounds: ['pleasurehorizons:lucy.orgasm'] } });
    });

    it('the same tokens twice give one binding, sorted by token', () => {
        const set = bindingSetFor(LUCY, ['stripmsg1', 'bjimsg8', 'stripmsg1']);

        expect(Object.keys(set.bindings)).toEqual(['bjimsg8', 'stripmsg1']);
    });
});

describe('classifyToken', () => {
    it('tags by what PH does with the token', () => {
        expect(classifyToken('thrust', [LUCY])).toBe('gameplay');
        expect(classifyToken('anal_cumblackscreen', [LUCY])).toBe('ui');
        expect(classifyToken('sexuion', [LUCY])).toBe('ui');
        expect(classifyToken('stripmsg1', [LUCY])).toBe('message/sound');
        expect(classifyToken('pound-cum-orgasm1', [LUCY])).toBe('message/sound');
        expect(classifyToken('attacksound', [LUCY])).toBe('no consumer');
        expect(classifyToken('doggyintromsg3', [LUCY])).toBe('inert');
        expect(classifyToken('swap_end', [LUCY])).toBe('gameplay');
        expect(classifyToken('paizuri_startstep', [LUCY])).toBe('gameplay');
    });
});

describe('cue rules (the decisions a person makes in the GUI)', () => {
    const event = (payload: string): LegacyEvent => ({ clip: 'animation.a', time: 1, kind: EVENT_KIND_SOUND, payload });
    const run = (payload: string, rules: CueMapping) => {
        const reports: string[] = [];
        const events = markerEventMapper({ rules })(event(payload), (_severity, message) => reports.push(message));

        return { events: events.map(e => [e.kind, e.payload, e.authority]), reports };
    };

    it('a sound rule writes a sound event (the cue itself by default), a marker rule only sets where it runs, a leave-out writes nothing', () => {
        expect(run('a, b, c, d', {
            a: { action: 'sound', value: 'pleasurehorizons:x.y', authority: 'client' },
            b: { action: 'sound' },
            c: { action: 'marker', authority: 'server' },
            d: { action: 'leave-out' },
        }).events).toEqual([['sound', 'pleasurehorizons:x.y', 2], ['sound', 'b', 0], ['instruction', 'c', 1]]);
    });

    it('a custom rule writes the event line as it is, on the chosen side', () => {
        expect(run('fade', { fade: { action: 'custom', value: ' pleasurehorizons:fade_to_black 1.5 ', authority: 'both' } }).events)
            .toEqual([['instruction', 'pleasurehorizons:fade_to_black 1.5', 3]]);
    });

    it('a rule that cannot be applied is reported and the cue is left out, never written wrongly', () => {
        const bad = run('x', { x: { action: 'custom', value: 'no namespace here' } });

        expect(bad.events).toEqual([]);
        expect(bad.reports[0]).toContain('namespaced type');
        expect(ruleProblem('y', { action: 'custom' })).toContain('no event line');
        expect(ruleProblem('z', { action: 'sound', value: 'bad value!' })).toContain('may only use');
        expect(ruleProblem('ok', { action: 'sound', value: 'pleasurehorizons:a.b' })).toBeNull();
    });

    it('onCue sees every token, including the ones a rule leaves out; onToken only the markers', () => {
        const cues: string[] = [];
        const markers: string[] = [];

        markerEventMapper({ rules: { b: { action: 'leave-out' }, c: { action: 'sound' } }, onCue: t => cues.push(t), onToken: t => markers.push(t) })(event('a, b, c'), () => {});

        expect(cues).toEqual(['a', 'b', 'c']);
        expect(markers).toEqual(['a']);
    });
});
