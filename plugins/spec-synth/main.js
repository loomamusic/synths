// Spec Synth's page. It talks to the host only through window.hostContext
// (contract section 10), and builds a control for every parameter and a
// readout for every meter from the validated manifest.

"use strict";

const host = window.hostContext;
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
};

// ---- Formatting and slider mapping -----------------------------------------------

function format(p, v) {
    switch (p.type) {
        case "enum":
            return p.options[v] ?? String(v);
        case "bool":
            return v ? "On" : "Off";
        case "int":
            return `${v}${p.unit ? ` ${p.unit}` : ""}`;
        default:
            if (p.unit === "Hz") return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
            if (p.unit === "s") return v < 1 ? `${(v * 1000).toFixed(v < 0.01 ? 1 : 0)} ms` : `${v.toFixed(2)} s`;
            if (p.unit === "dB") return `${v.toFixed(1)} dB`;
            return p.unit ? `${v.toFixed(2)} ${p.unit}` : v.toFixed(2);
    }
}

// A float slider runs 0..SLIDER_STEPS and maps to [min, max] with the
// parameter's skew, the same shape a DAW's normalised value has (section 4.3).
// The host makes every value valid, so this mapping needn't be exact.
const SLIDER_STEPS = 1000;
function toSlider(p, v) {
    const n = p.skew === "log" ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
    return Math.round(Math.min(1, Math.max(0, n)) * SLIDER_STEPS);
}
function fromSlider(p, position) {
    const n = position / SLIDER_STEPS;
    return p.skew === "log" ? p.min * (p.max / p.min) ** n : p.min + n * (p.max - p.min);
}

// ---- Parameters ---------------------------------------------------------------------

// Builds one parameter's control. Returns a function that shows a value.
function buildControl(p) {
    const id = `param-${p.id}`;
    const readout = el("output", { className: "readout", htmlFor: id });
    const row = el("div", { className: `control control-${p.type}` });
    row.dataset.param = p.id;
    let input;
    let show;

    if (p.type === "enum") {
        input = el("select", { id }, p.options.map((label, i) => el("option", { value: String(i), textContent: label })));
        input.addEventListener("change", () => set(p, Number(input.value)));
        show = (v) => {
            input.value = String(v);
            readout.value = format(p, v);
        };
    } else if (p.type === "bool") {
        input = el("input", { id, type: "checkbox" });
        input.addEventListener("change", () => set(p, input.checked ? 1 : 0));
        show = (v) => {
            input.checked = v === 1;
            readout.value = format(p, v);
        };
    } else {
        const isInt = p.type === "int";
        input = el("input", {
            id,
            type: "range",
            min: isInt ? String(p.min) : "0",
            max: isInt ? String(p.max) : String(SLIDER_STEPS),
            step: "1",
        });
        const valueOf = () => (isInt ? Number(input.value) : fromSlider(p, Number(input.value)));
        // A drag is one gesture, so a DAW records it as one (section 10.3). It
        // ends when the pointer is released anywhere, even if nothing changed.
        input.addEventListener("pointerdown", () => {
            host.params.beginEdit(p.id);
            const end = () => {
                host.params.endEdit(p.id);
                window.removeEventListener("pointerup", end, true);
                window.removeEventListener("pointercancel", end, true);
            };
            window.addEventListener("pointerup", end, true);
            window.addEventListener("pointercancel", end, true);
        });
        // Keyboard changes arrive here too, outside a gesture, which set allows.
        input.addEventListener("input", () => set(p, valueOf(), false));
        input.addEventListener("dblclick", () => {
            // Double-click returns the parameter to its default.
            set(p, p.default);
        });
        show = (v, moveSlider = true) => {
            if (moveSlider) input.value = String(isInt ? v : toSlider(p, v));
            readout.value = format(p, v);
        };
    }

    row.append(el("label", { htmlFor: id, textContent: p.name }), input, readout);
    $("controls").append(row);
    shows.set(p.id, show);
    return show;
}

const shows = new Map();

// Sets a value, then shows the value the host made of it (section 4.3: it
// clamps, rounds, and stores it as a 32-bit float).
function set(p, value, moveSlider = true) {
    host.params.set(p.id, value);
    shows.get(p.id)(host.params.get(p.id), moveSlider);
}

// ---- Meters ---------------------------------------------------------------------------

function buildMeters(meters) {
    const meterShows = new Map();
    for (const m of meters) {
        const readout = el("output", { className: "readout", textContent: "–" });
        const row = el("div", { className: "meter" }, [el("span", { className: "meter-name", textContent: m.name }), readout]);
        row.dataset.meter = m.id;
        let bar = null;
        if (m.id === "level") {
            bar = el("meter", { min: -60, max: 6, low: -18, high: -3, optimum: -30, value: -60 });
            row.append(bar);
        }
        $("meters").append(row);
        meterShows.set(m.id, (v) => {
            readout.value = m.id === "level" ? (v <= -100 ? "−∞ dB" : `${v.toFixed(1)} dB`) : String(Math.round(v));
            if (bar) bar.value = Math.max(-60, v);
        });
    }
    host.meters.subscribe((values) => {
        for (const [id, v] of Object.entries(values)) meterShows.get(id)?.(v);
    });
}

// ---- Keys --------------------------------------------------------------------------------

const KEY_COUNT = 13; // C to C
const COMPUTER_KEYS = ["a", "w", "s", "e", "d", "f", "t", "g", "y", "h", "u", "j", "k"];
const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const CHANNEL = 0;

let octave = 4; // the first key is C in this octave; C4 is MIDI key 60
const sounding = new Map(); // on-screen key index -> MIDI key sounding

function midiKey(i) {
    return 12 * (octave + 1) + i;
}

function press(i, velocity) {
    if (sounding.has(i)) return;
    const key = midiKey(i);
    if (key < 0 || key > 127) return;
    host.notes.noteOn(CHANNEL, key, velocity);
    sounding.set(i, key);
    keyElements[i].classList.add("down");
}

function release(i) {
    const key = sounding.get(i);
    if (key === undefined) return;
    host.notes.noteOff(CHANNEL, key);
    sounding.delete(i);
    keyElements[i].classList.remove("down");
}

function releaseAll() {
    for (const i of [...sounding.keys()]) release(i);
}

const keyElements = [];

function buildKeys() {
    const keys = $("keys");
    for (let i = 0; i < KEY_COUNT; i++) {
        const key = el("div", { className: BLACK.has(i % 12) ? "key black" : "key white" });
        key.dataset.key = String(i);
        key.setAttribute("role", "button");
        key.addEventListener("pointerdown", (e) => {
            key.setPointerCapture(e.pointerId);
            // Lower on the key is louder: velocity 0.3 at the top to 1 at the bottom.
            const rect = key.getBoundingClientRect();
            const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
            press(i, 0.3 + 0.7 * y);
        });
        for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) key.addEventListener(type, () => release(i));
        keyElements.push(key);
        keys.append(key);
    }
    labelKeys();

    window.addEventListener("keydown", (e) => {
        if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLSelectElement) return;
        const i = COMPUTER_KEYS.indexOf(e.key.toLowerCase());
        if (i >= 0) press(i, 0.8);
    });
    window.addEventListener("keyup", (e) => {
        const i = COMPUTER_KEYS.indexOf(e.key.toLowerCase());
        if (i >= 0) release(i);
    });
    // Don't leave notes hanging when the window loses focus.
    window.addEventListener("blur", releaseAll);

    $("octave-down").addEventListener("click", () => setOctave(octave - 1));
    $("octave-up").addEventListener("click", () => setOctave(octave + 1));
}

function labelKeys() {
    keyElements.forEach((key, i) => {
        key.textContent = i % 12 === 0 ? `C${octave + Math.floor(i / 12)}` : "";
        key.title = `${NOTE_NAMES[i % 12]}${octave + Math.floor(i / 12)}`;
    });
    $("octave-label").textContent = `C${octave}`;
}

// The keyboard's octave is UI state: the host saves it with the session (section 9.1).
function setOctave(value) {
    releaseAll();
    octave = Math.min(8, Math.max(-1, value));
    labelKeys();
    host.uiState.save({ octave });
}

// ---- Start -----------------------------------------------------------------------------------

function showError(error) {
    $("errors").hidden = false;
    $("error-list").append(el("li", { textContent: `${error.code}: ${error.message}` }));
}

host.ready.then(
    () => {
        const manifest = host.manifest;
        for (const p of manifest.parameters) {
            const show = buildControl(p);
            show(host.params.get(p.id));
            // Changes from anywhere but this page: DAW automation, a restore (section 10.3).
            host.params.subscribe(p.id, (v) => show(v));
        }
        buildMeters(manifest.meters ?? []);
        const saved = host.uiState.load();
        if (saved && Number.isInteger(saved.octave)) octave = Math.min(8, Math.max(-1, saved.octave));
        buildKeys();
        host.onError(showError);
        $("status").textContent = `${manifest.name} ${manifest.version} · ready`;
        document.body.classList.add("ready");
    },
    (error) => {
        $("status").textContent = `Couldn't load: ${error.message}`;
        document.body.classList.add("failed");
    },
);
