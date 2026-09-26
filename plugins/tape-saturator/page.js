// The tape saturator's page. It builds a control for each parameter in the
// manifest, by type, and a bar for each meter, and talks to the plugin only
// through window.hostContext (contract section 10). It runs on the page's
// thread; the sound is made by the processor, not here.
//
//   float  a slider, log-scaled if the manifest says skew: "log"
//   int    a slider in whole steps
//   enum   a list of the options
//   bool   a checkbox
//
// Nothing here is specific to this plugin, so it can serve as a template.

const { params } = hostContext;
const status = document.getElementById("status");

hostContext.ready.then(build, (err) => show(`Couldn't load the plugin: ${err.message}`, true));
hostContext.onError((err) => show(err.message, true));

function show(message, isError = false) {
    status.textContent = message;
    status.classList.toggle("error", isError);
}

function build() {
    show("");
    const { parameters, meters = [] } = hostContext.manifest;
    const controls = document.getElementById("controls");
    for (const p of parameters) controls.append(row(p.name, p.id, control(p)));
    const bars = new Map();
    const meterList = document.getElementById("meters");
    for (const m of meters) {
        const bar = meterBar(m);
        bars.set(m.id, bar);
        meterList.append(bar.row);
    }
    hostContext.meters.subscribe((values) => {
        for (const [id, value] of Object.entries(values)) bars.get(id)?.update(value);
    });
}

// A labelled row: name, control, and optionally a readout.
function row(name, id, { input, readout }) {
    const div = document.createElement("div");
    div.className = "row";
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = name;
    input.id = id;
    div.append(label, input);
    if (readout) div.append(readout);
    return div;
}

// Returns { input, readout } for a parameter, kept in step with its value.
function control(p) {
    if (p.type === "enum") return choice(p);
    if (p.type === "bool") return toggle(p);
    return slider(p);
}

function choice(p) {
    const input = document.createElement("select");
    p.options.forEach((label, i) => input.add(new Option(label, String(i))));
    input.value = String(params.get(p.id));
    input.addEventListener("change", () => params.set(p.id, Number(input.value)));
    params.subscribe(p.id, (v) => (input.value = String(v)));
    return { input };
}

function toggle(p) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = params.get(p.id) === 1;
    input.addEventListener("change", () => params.set(p.id, input.checked ? 1 : 0));
    params.subscribe(p.id, (v) => (input.checked = v === 1));
    return { input };
}

// The slider runs 0 to 1, mapped to the parameter's range as the manifest's
// skew says, so a log parameter such as a frequency gets equal room per octave.
function slider(p) {
    const log = p.skew === "log";
    const toValue = (n) => (log ? p.min * Math.exp(n * Math.log(p.max / p.min)) : p.min + n * (p.max - p.min));
    const toPosition = (v) => (log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "1";
    input.step = p.type === "int" ? String(1 / (p.max - p.min)) : "any";
    const readout = document.createElement("output");
    readout.htmlFor = p.id;
    const showValue = (v) => {
        input.value = String(toPosition(v));
        readout.value = format(v, p);
    };
    showValue(params.get(p.id));

    // A drag is one gesture for the DAW's automation: beginEdit on the first
    // change, endEdit when the slider is let go.
    let editing = false;
    input.addEventListener("input", () => {
        if (!editing) params.beginEdit(p.id);
        editing = true;
        params.set(p.id, toValue(Number(input.value)));
        readout.value = format(params.get(p.id), p);
    });
    input.addEventListener("change", () => {
        if (editing) params.endEdit(p.id);
        editing = false;
    });
    params.subscribe(p.id, showValue);
    return { input, readout };
}

function format(v, p) {
    if (p.unit === "Hz") return v < 1000 ? `${Math.round(v)} Hz` : `${(v / 1000).toFixed(1)} kHz`;
    if (p.type === "int") return `${v}${p.unit ? ` ${p.unit}` : ""}`;
    return `${v.toFixed(2)}${p.unit ? ` ${p.unit}` : ""}`;
}

// A level meter in dB, from -100 (the processor's floor) to 0.
function meterBar(m) {
    const div = document.createElement("div");
    div.className = "row";
    const name = document.createElement("span");
    name.textContent = m.name.replace(/ \(dB\)$/, "");
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", m.name);
    bar.setAttribute("aria-valuemin", "-100");
    bar.setAttribute("aria-valuemax", "0");
    const fill = document.createElement("div");
    bar.append(fill);
    const value = document.createElement("span");
    value.className = "value";
    div.append(name, bar, value);
    const update = (db) => {
        const clamped = Math.min(0, Math.max(-100, db));
        bar.setAttribute("aria-valuenow", db.toFixed(1));
        fill.style.width = `${clamped + 100}%`;
        value.textContent = db <= -100 ? "−∞ dB" : `${db.toFixed(1)} dB`;
    };
    update(-100);
    return { row: div, update };
}
