import { convertAnimationFile } from '../ts/convert/animationToRaw';
import { decodeAnimation, encodeAnimation, EVENT_FIELD_SEPARATOR } from '../ts/binary/animation';

/**
 * Stage 1 of the converter (AI Info/CONVERTER_PLAN.md): legacy JSON to the raw animation, verified by encoding it and decoding it back
 */
function convert(animations: Record<string, unknown>, options = {}) {
    return convertAnimationFile({ format_version: '1.8.0', animations }, { file: 'test.animation.json', ...options });
}

describe('convertAnimationFile', () => {
    it('reads a timeline: times sorted, rotation X and Y negated, position X negated, scale copied', () => {
        const { animation } = convert({
            'animation.a': {
                loop: true,
                animation_length: 2,
                bones: {
                    arm: {
                        rotation: { '1.0': { vector: [0, 90, 0] }, '0.0': { vector: [10, 0, 0] } },
                        position: { '0.0': { vector: [1, 2, 3] }, '1.0': [-4, 5, 6] },
                        scale: { '0.0': { vector: [1, 1.5, 1] } },
                    },
                },
            },
        });
        const clip = animation.clips[0];

        expect(clip.name).toBe('animation.a');
        expect(clip.duration).toBe(2);
        expect(clip.loop).toBe('LOOP');

        const rotation = clip.channels.find(c => c.property === 'ROTATION')!;
        const position = clip.channels.find(c => c.property === 'POSITION')!;
        const scale = clip.channels.find(c => c.property === 'SCALE')!;

        expect(rotation.keys.map(k => k.time)).toEqual([0, 1]);
        expect(rotation.keys[0].value.literals).toEqual([-10, 0, 0]);
        expect(rotation.keys[1].value.literals).toEqual([0, -90, 0]);
        expect(position.keys[0].value.literals).toEqual([-1, 2, 3]);
        expect(position.keys[1].value.literals).toEqual([4, 5, 6]);
        expect(scale.keys[0].value.literals).toEqual([1, 1.5, 1]);
        expect(position.target).toBe('arm');
        expect(position.targetKind).toBe('GROUP_BONE');
    });

    it('does not turn a zero X into negative zero', () => {
        const value = convert({ a: { bones: { b: { position: [0, 0, 0] } } } }).animation.clips[0].channels[0].keys[0].value.literals[0];

        expect(Object.is(value, 0)).toBe(true);
    });

    it('a constant vector becomes one key at time 0', () => {
        const { animation } = convert({ a: { bones: { b: { rotation: { vector: [5, 6, 7] }, scale: [2, 2, 2] } } } });
        const [rotation, scale] = animation.clips[0].channels;

        expect(rotation.keys).toHaveLength(1);
        expect(rotation.keys[0].time).toBe(0);
        expect(rotation.keys[0].value.literals).toEqual([-5, -6, 7]);
        expect(scale.keys[0].value.literals).toEqual([2, 2, 2]);
    });

    it('easing: a known name is kept, linear becomes none, an unknown name is reported, args are kept only for easings that take them', () => {
        const { animation, findings } = convert({
            a: {
                bones: {
                    b: {
                        rotation: {
                            '0': { vector: [0, 0, 0], easing: 'easeInOutSine' },
                            '1': { vector: [0, 0, 0], easing: 'linear' },
                            '2': { vector: [0, 0, 0], easing: 'notAnEasing' },
                            '3': { vector: [0, 0, 0], easing: 'easeOutElastic', easingArgs: [0.5] },
                        },
                    },
                },
            },
        });
        const keys = animation.clips[0].channels[0].keys;

        expect(keys[0].easing).toBe('easeInOutSine');
        expect(keys[1].easing).toBeNull();
        expect(keys[2].easing).toBeNull();
        expect(keys[3].easing).toBe('easeOutElastic');
        expect(keys[3].easingArgs).toEqual([0.5]);
        expect(findings.items.filter(f => f.severity === 'lossy').map(f => f.message).join('|')).toContain('notAnEasing');
    });

    it('an easing name used as a vector value is written as 0 and reported (the doggy scene data)', () => {
        const { animation, findings } = convert({
            a: { bones: { boobR: { position: { vector: ['easeInOutSine', 'easeInOutSine', 'easeInOutSine'] } } } },
        });
        const value = animation.clips[0].channels[0].keys[0].value;

        expect(value.literals).toEqual([0, 0, 0]);
        expect(value.expressions).toEqual([null, null, null]);
        expect(findings.lossy).toBe(3);
        expect(findings.items[0].bone).toBe('boobR');
        expect(findings.items[0].clip).toBe('a');
    });

    it('Molang: an expression is kept, position X is negated as -(expr), a numeric string is a literal', () => {
        const { animation } = convert({
            a: { bones: { b: { position: { '0': { vector: ['math.sin(query.anim_time)', '2 * 3', '4'] } } } } },
        });
        const value = animation.clips[0].channels[0].keys[0].value;

        expect(value.expressions).toEqual(['-(math.sin(query.anim_time))', '2 * 3', null]);
        expect(value.literals).toEqual([0, 0, 4]);
    });

    it('a Blockbench placeholder (SIZE) is written as variable.size and reported once; a damaged value (NaN-(linear), -(linear)) is 0 and reported', () => {
        const { animation, findings } = convert({
            a: {
                bones: {
                    b: { rotation: { '0': { vector: ['-4.7757 + SIZE * 15', 'NaN-(linear)', '-(linear)'] } } },
                    c: { rotation: { '0': { vector: ['SIZE * 2', 'math.sin(query.anim_time) + PI', '1'] } } },
                },
            },
        });
        const first = animation.clips[0].channels[0].keys[0].value;
        const second = animation.clips[0].channels[1].keys[0].value;

        expect(first.expressions).toEqual(['-4.7757 + variable.size * 15', null, null]);
        expect(first.literals.slice(1)).toEqual([0, 0]);
        expect(second.expressions).toEqual(['variable.size * 2', 'math.sin(query.anim_time) + PI', null]);
        expect(findings.items.filter(f => f.message.includes('placeholder "SIZE"')).length).toBe(2);
        expect(findings.items.filter(f => f.message.includes('is damaged')).length).toBe(2);
    });

    it('loop modes and the duration fallback', () => {
        const { animation } = convert({
            once: { bones: { b: { rotation: { '0': [0, 0, 0], '1.5': [1, 1, 1] } } } },
            hold: { loop: 'hold_on_last_frame', animation_length: 3 },
            looping: { loop: true },
        });

        expect(animation.clips.map(c => c.loop)).toEqual(['PLAY_ONCE', 'HOLD_ON_LAST_FRAME', 'LOOP']);
        expect(animation.clips[0].duration).toBe(1.5);
        expect(animation.clips[1].duration).toBe(3);
    });

    it('pre and post keep their meaning: post alone is the value, pre with post gives a separate outgoing value, both may be wrapped in {vector}', () => {
        const { animation, findings } = convert({
            a: {
                bones: {
                    b: {
                        rotation: {
                            '0': { post: { vector: [-80, 0, 0] }, lerp_mode: 'catmullrom' },
                            '1': { pre: { vector: [1, 2, 3] }, post: [4, 5, 6] },
                        },
                    },
                },
            },
        });
        const [only, both] = animation.clips[0].channels[0].keys;

        expect(only.value.literals).toEqual([80, 0, 0]);
        expect(only.post).toBeNull();
        expect(both.value.literals).toEqual([-1, -2, 3]);
        expect(both.post?.literals).toEqual([-4, -5, 6]);
        expect(findings.lossy).toBe(0);
    });

    it('lerp_mode catmullrom marks the key, and a channel of mixed interpolation is mixed', () => {
        const { animation } = convert({
            a: { bones: { b: { rotation: { '0': { vector: [0, 0, 0], lerp_mode: 'catmullrom' }, '1': { vector: [0, 0, 0] } } } } },
        });
        const channel = animation.clips[0].channels[0];

        expect(channel.keys.map(k => k.interpolation)).toEqual(['CATMULLROM', 'LINEAR']);
        expect(channel.interpolation).toBeNull();
    });

    it('sound, particle and timeline events pass through as the three legacy kinds, in time order, several per time kept in order', () => {
        const { animation } = convert({
            a: {
                sound_effects: { '2.0': { effect: 'late' }, '1.0': [{ effect: 'first' }, { effect: 'second' }] },
                particle_effects: { '1.0': { effect: 'puff', locator: 'hand' } },
                timeline: { '0.5': ['pleasurehorizons:fade', 'swap_end'] },
            },
        });
        const events = animation.clips[0].events;

        expect(events.map(e => [e.time, e.kind, e.payload])).toEqual([
            [0.5, 'instruction', 'pleasurehorizons:fade\nswap_end'],
            [1, 'sound', 'first'],
            [1, 'sound', 'second'],
            [1, 'particle', ['puff', 'hand', ''].join(EVENT_FIELD_SEPARATOR)],
            [2, 'sound', 'late'],
        ]);
        expect(events.every(e => e.authority === 0)).toBe(true);
    });

    it('the event hook can replace and split events', () => {
        const { animation } = convert({ a: { sound_effects: { '1': { effect: 'aMSG1, thrust' } } } }, {
            mapEvent: (event: { time: number; payload: string }) => event.payload.split(',').map(token => ({
                time: event.time, kind: 'instruction', payload: token.trim(), authority: 0,
            })),
        });

        expect(animation.clips[0].events.map(e => e.payload)).toEqual(['aMSG1', 'thrust']);
    });

    it('unknown fields are reported, not silently dropped', () => {
        const { findings } = convert({ a: { blend_weight: 1, bones: { b: { rotation: [0, 0, 0], mystery: 1 } } } });
        const text = findings.items.map(f => f.message).join('|');

        expect(text).toContain('blend_weight');
        expect(text).toContain('mystery');
    });

    it('a file with no animations reports that and converts nothing', () => {
        const { animation, findings } = convertAnimationFile({ nope: 1 }, { file: 'x.json' });

        expect(animation.clips).toHaveLength(0);
        expect(findings.lossy).toBe(1);
    });

    it('the converted animation encodes and decodes back to itself, including its string table', () => {
        const { animation } = convert({
            'animation.full': {
                loop: true,
                animation_length: 1,
                bones: { arm: { rotation: { '0': { vector: [1, 2, 3], easing: 'easeInOutSine' }, '1': { vector: [4, 5, 6] } } } },
                sound_effects: { '0.5': { effect: 'stripMSG1' } },
            },
        }, { skeletonFingerprint: 12345 });
        const decoded = decodeAnimation(encodeAnimation(animation), 'test');

        expect(decoded.skeletonFingerprint).toBe(12345);
        expect(decoded.clips[0].name).toBe('animation.full');
        expect(decoded.clips[0].channels[0].keys[0].easing).toBe('easeInOutSine');
        expect(decoded.clips[0].channels[0].keys[1].value.literals).toEqual([-4, -5, 6]);
        expect(decoded.clips[0].events[0]).toMatchObject({ time: 0.5, kind: 'sound', payload: 'stripMSG1' });
    });
});

describe('a short all-Molang key at the very end of a file', () => {
    it('decodes: the reader must not assume every key holds three floats', () => {
        const { animation } = convertAnimationFile({
            animations: { a: { bones: { b: { position: { '0': { vector: ['math.sin(query.anim_time)', 'math.cos(query.anim_time)', 'query.anim_time'] } } } } } },
        }, { file: 'x.json' });
        const decoded = decodeAnimation(encodeAnimation(animation), 'short');

        expect(decoded.clips[0].channels[0].keys[0].value.expressions[2]).toBe('query.anim_time');
    });
});

describe('malformed values found in real data', () => {
    it('a number with an easing name pasted after it keeps the number (reported), and a stray backtick is dropped (reported)', () => {
        const { animation, findings } = convertAnimationFile({ animations: { a: { bones: { b: {
            rotation: { '0': ['12.5+easeInOutSine', '`-11', 3] },
            position: { '0': ['2+easeInSine', 0, 0] },
        } } } } }, { file: 'x.animation.json', skeletonFingerprint: 0 });
        const [rotation, position] = animation.clips[0].channels;

        expect(rotation.keys[0].value.literals).toEqual([-12.5, 11, 3]);
        expect(position.keys[0].value.literals).toEqual([-2, 0, 0]);
        expect(rotation.keys[0].value.expressions).toEqual([null, null, null]);
        expect(findings.items.filter(f => f.severity === 'lossy')).toHaveLength(2);
        expect(findings.items.filter(f => f.severity === 'changed')).toHaveLength(1);
    });
});
