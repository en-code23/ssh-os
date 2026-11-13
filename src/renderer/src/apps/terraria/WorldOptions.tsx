import type { Dispatch, SetStateAction } from 'react'
import { DIFFICULTIES, EVILS, SECRET_SEEDS, SIZES, evilSupported, type TrWorldOptions } from '../../lib/tr/worldgen'
import type { TrSoftware } from '../../lib/tr/server'
import { Row } from '../minecraft/common'
import { SeedInput } from '../minecraft/Website'

/** All of Terraria's world creation options: name, size, difficulty, evil, secret seeds, seed. */
export function TrWorldForm({ value, onChange, software }: { value: TrWorldOptions; onChange: Dispatch<SetStateAction<TrWorldOptions>>; software: TrSoftware }) {
  // functional updates: quick successive clicks never overwrite each other
  const set = (p: Partial<TrWorldOptions>) => onChange((v) => ({ ...v, ...p }))
  const secret = SECRET_SEEDS.find((s) => s.seed === value.secret)
  const canEvil = evilSupported(software)
  return (
    <>
      <Row label="World name"><input className="input" style={{ width: 240 }} value={value.name} onChange={(e) => set({ name: e.target.value })} /></Row>
      <Row label="Size" help={SIZES.map((s) => `${s.label} (${s.dims}): ${s.help}`).join('\n')}>
        <div className="segmented">
          {SIZES.map((s) => <button key={s.v} className={value.size === s.v ? 'on' : ''} onClick={() => set({ size: s.v })}>{s.label}</button>)}
        </div>
      </Row>
      <Row label="Difficulty" help={DIFFICULTIES.map((d) => `${d.label}: ${d.help}`).join('\n')}>
        <div className="segmented">
          {DIFFICULTIES.map((d) => <button key={d.v} className={value.difficulty === d.v ? 'on' : ''} onClick={() => set({ difficulty: d.v })}>{d.label}</button>)}
        </div>
      </Row>
      <Row
        label="World evil"
        help="Corruption or Crimson: the evil biome that spreads through the world. Each has its own boss (Eater of Worlds / Brain of Cthulhu), ores and items."
        sub={!canEvil ? 'Only TShock servers can choose; others pick at random.' : value.secret === '05162020' || value.secret === 'get fixed boi' ? 'This secret seed has both evils.' : undefined}
      >
        <div className="segmented" style={{ opacity: canEvil ? 1 : 0.5 }}>
          {EVILS.map((e) => <button key={e.v} disabled={!canEvil} className={value.evil === e.v ? 'on' : ''} onClick={() => set({ evil: e.v })}>{e.label}</button>)}
        </div>
      </Row>
      <Row label="Secret seed" help="Special worlds built into Terraria. They replace the normal seed." sub={secret?.help || undefined}>
        <select className="select" style={{ width: 220 }} value={value.secret} onChange={(e) => set({ secret: e.target.value })}>
          {SECRET_SEEDS.map((s) => <option key={s.seed} value={s.seed}>{s.label}</option>)}
        </select>
      </Row>
      {!value.secret && (
        <Row label="Seed" help="The same seed and options always give the same world. Leave empty for a random world.">
          <SeedInput game="terraria" value={value.seed} onChange={(v) => set({ seed: v })} />
        </Row>
      )}
    </>
  )
}
