import { clockS } from './data.js';

/** A status lamp: live (a fresh reading), wait (reading, or switched off for now), error, off (not set: TBA). */
export const Lamp = ({ state }) => <i className="kf-lamp" data-state={state} aria-hidden="true" />;

/**
 * The strip on top of every instrument: the agent tool it mirrors written as the call this page made, with its inputs,
 * and on the right when the reading was taken. The switches below a head edit the call in place.
 */
export function ToolHead({ name, args, state, at, idle }) {
  const said = state === 'wait' ? 'reading' : state === 'error' ? 'no reading' : state === 'idle' ? idle : clockS(at);
  return <header className="kf-tool-head">
    <Lamp state={state === 'idle' ? 'off' : state} />
    <code className="kf-call"><b>{name}</b>(<span>{args?.map(([k, v], i) => <span key={k}>{i ? ', ' : ''}{k}: <i>{v}</i></span>)}</span>)</code>
    <time className="kf-tool-at">{said}</time>
  </header>;
}

/** A segmented switch. The label is the input's own name. */
export function Seg({ label, value, options, onChange, wide }) {
  const id = 'kf-seg-' + label.replace(/\W+/g, '-');
  return <div className={'kf-seg' + (wide ? ' wide' : '')}>
    <span className="kf-seg-label" id={id}>{label}</span>
    <div className="kf-seg-keys" role="radiogroup" aria-labelledby={id}>
      {options.map(([v, text]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{text}</button>)}
    </div>
  </div>;
}

export const Coin = ({ t, size = 18 }) => t?.image
  ? <img className="kv-coin" src={t.image} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" />
  : <span className="kv-coin mono" style={{ width: size, height: size }}>{(t?.symbol || '?').slice(0, 2)}</span>;
