/**
 * Terraria world generation with every option the game offers when creating a world.
 *
 * The server binary is started once with a temporary config (and, for TShock, its own
 * temporary config folder) on a random free port. It generates and saves the world, then
 * it is stopped. That way worlds can be previewed and kept without touching the running server.
 */
import { shq } from '../api'
import { startCommand, type TrSoftware } from './server'

export type TrEvil = 'random' | 'corrupt' | 'crimson'

export interface TrWorldOptions {
  name: string
  /** autocreate: 1 small, 2 medium, 3 large */
  size: '1' | '2' | '3'
  /** 0 classic, 1 expert, 2 master, 3 journey */
  difficulty: '0' | '1' | '2' | '3'
  evil: TrEvil
  /** secret seed text, or '' for none */
  secret: string
  /** normal seed (number or text); empty = random */
  seed: string
}

export const SIZES = [
  { v: '1', label: 'Small', dims: '4200 × 1200', help: 'About 1–4 players. Fastest to explore.' },
  { v: '2', label: 'Medium', dims: '6400 × 1800', help: 'About 4–8 players.' },
  { v: '3', label: 'Large', dims: '8400 × 2400', help: '8+ players. Uses the most memory.' },
] as const

export const DIFFICULTIES = [
  { v: '3', label: 'Journey', help: 'Creative powers: duplicate items, change time and weather, god mode.' },
  { v: '0', label: 'Classic', help: 'The normal Terraria experience.' },
  { v: '1', label: 'Expert', help: 'Stronger enemies and better loot (treasure bags, expert items).' },
  { v: '2', label: 'Master', help: 'Even harder than Expert, with extra relics and pets.' },
] as const

export const EVILS = [
  { v: 'random', label: 'Random' },
  { v: 'corrupt', label: 'Corruption' },
  { v: 'crimson', label: 'Crimson' },
] as const

/** The game's secret world seeds. */
export const SECRET_SEEDS = [
  { seed: '', label: 'None', help: '' },
  { seed: '05162020', label: 'Drunk world', help: 'Both Corruption and Crimson, a moon-lord-themed world and many oddities.' },
  { seed: 'for the worthy', label: 'For the worthy', help: 'A much harder world: tougher enemies, bigger bosses, traps everywhere.' },
  { seed: 'not the bees', label: 'Not the bees', help: 'The whole world is a bee hive and jungle.' },
  { seed: 'celebrationmk10', label: 'Celebrationmk10', help: '10th anniversary: party theme and special developer items.' },
  { seed: 'the constant', label: 'The Constant', help: "Don't Starve crossover: darkness hurts, hunger and different visuals." },
  { seed: 'dont dig up', label: "Don't dig up", help: 'The world is flipped: start near the underworld and climb to the surface.' },
  { seed: 'no traps', label: 'No traps', help: 'Ironically, traps everywhere.' },
  { seed: 'get fixed boi', label: 'Get fixed boi (Zenith)', help: 'Combines all secret seeds. Very hard; for experienced players.' },
] as const

export const defaultWorldOptions = (name: string, size: TrWorldOptions['size'] = '2'): TrWorldOptions => ({
  name, size, difficulty: '0', evil: 'random', secret: '', seed: '',
})

export const worldFileName = (name: string) => (name.replace(/[^\w -]+/g, '').trim().replace(/\s+/g, '_') || 'World') + '.wld'

/** Values for serverconfig.txt (used for autocreate on start as a fallback). */
export function worldConfigValues(o: TrWorldOptions) {
  return { autocreate: o.size, worldname: o.name.trim(), difficulty: o.difficulty, seed: (o.secret || o.seed).trim() }
}

export const evilSupported = (sw: TrSoftware) => sw === 'tshock'

/**
 * Shell script that generates a world file at `target` with the given options.
 * Prints progress; exits non-zero on failure.
 */
export function generateWorldScript(sw: TrSoftware, dir: string, target: string, o: TrWorldOptions) {
  const clean = (s: string) => s.replace(/[\r\n]/g, ' ').trim()
  const conf = [
    `autocreate=${o.size}`,
    `worldname=${clean(o.name) || 'World'}`,
    `difficulty=${o.difficulty}`,
    ...(clean(o.secret || o.seed) ? [`seed=${clean(o.secret || o.seed)}`] : []),
    'maxplayers=1',
    'secure=0',
    'upnp=0',
    'language=en-US',
  ].join('\n')
  let cmd = startCommand(sw, dir).replace(/^exec /, '').replace('-config serverconfig.txt', '-config "$T/gen.txt"')
  if (sw === 'tshock') cmd += ` -configpath "$T/tshock" -logpath "$T/logs" -port "$PORT"${o.evil !== 'random' ? ` -worldevil ${o.evil}` : ''}`
  return `
D=${shq(dir)}; OUT=${shq(target)}
cd "$D" || exit 1
[ -x "$HOME/.sshos/dotnet/dotnet" ] && { DOTNET_ROOT="$HOME/.sshos/dotnet"; export DOTNET_ROOT; }
DOTNET_CLI_TELEMETRY_OPTOUT=1; export DOTNET_CLI_TELEMETRY_OPTOUT
mkdir -p "$(dirname "$OUT")"
if [ -e "$OUT" ]; then echo "A world file named $(basename "$OUT") already exists"; exit 3; fi
T=$(mktemp -d) || exit 1
PORT=$(( 17000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 2000 ))
cat > "$T/gen.txt" <<'SSHOS_GEN_EOF'
${conf}
SSHOS_GEN_EOF
printf 'world=%s\\nport=%s\\nworldpath=%s\\n' "$OUT" "$PORT" "$(dirname "$OUT")" >> "$T/gen.txt"
echo "Generating the world. This takes about 1–5 minutes depending on size and machine."
( tail -f /dev/null | ${cmd} > "$T/log" 2>&1 ) &
PP=$!
i=0; last=""
while [ $i -lt 1800 ]; do
  grep -qE "Server started|Listening on port|Type 'help'" "$T/log" 2>/dev/null && break
  kill -0 $PP 2>/dev/null || break
  l=$(tail -c 400 "$T/log" 2>/dev/null | tr '\\r' '\\n' | sed 's/\\x1b\\[[0-9;]*m//g' | grep -v '^ *$' | tail -n 1)
  if [ -n "$l" ] && [ "$l" != "$last" ]; then echo "$l"; last="$l"; fi
  sleep 2; i=$((i + 2))
done
pkill -f "$T/gen.txt" 2>/dev/null; sleep 2; pkill -9 -f "$T/gen.txt" 2>/dev/null
pkill -P $PP 2>/dev/null; kill $PP 2>/dev/null
if [ -s "$OUT" ]; then
  echo "World created: $(basename "$OUT") ($(du -h "$OUT" | cut -f1))"
  rm -rf "$T"
else
  echo "World generation failed. Last output:"
  tail -n 25 "$T/log" 2>/dev/null
  rm -rf "$T"
  exit 1
fi
`
}
