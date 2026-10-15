/// <reference types="blockbench-types" />

/**
 * blockbench-types 5.1 declares the `_Keyframe` class (its instance shape is the `_Keyframe`
 * type used throughout this plugin) but does not ambient-declare the runtime global Blockbench
 * itself exposes it under - `keyframe.js` ends with
 * `Object.assign(window, {KeyframeDataPoint, Keyframe, ...})`, confirmed against real
 * Blockbench 5.1.6 source while planning fork phase 5 (see `docs/PLUGIN_PORT_PLAN.md` §1). This
 * is what `keyframe.ts`'s monkeypatches target
 */
declare const Keyframe: typeof _Keyframe;

/**
 * blockbench-types 5.1 scoped {@code FormResultValue} to a genuine module export
 * (`interface/form.d.ts`) rather than the 4.9 package's ambient global, and dropped
 * {@code DialogFormElement} outright - the still-ambient {@code FormElementOptions} is its
 * closest 5.1 equivalent (the same field shape, confirmed against the 4.9 package this plugin
 * was written against)
 */
type FormResultValue = string | number | boolean | any[] | object;
type DialogFormElement = FormElementOptions;