// Move catalog: readable names + categories for the moves in animation packs and ★ My moves.

export const CATEGORIES = [
  { id: 'move', label: 'Walk & run' },
  { id: 'idle', label: 'Idle & stance' },
  { id: 'combat', label: 'Combat' },
  { id: 'magic', label: 'Spells' },
  { id: 'emote', label: 'Emotes' },
  { id: 'react', label: 'Hit & death' },
  { id: 'rest', label: 'Sit, sleep, use' },
  { id: 'other', label: 'Other' },
];

const RULES = [
  [/^(punch|sword|melee|pistol|overhand|throw|roll|slide|ninjajump|shielddash|swordblock|shieldoneshot|idleshield)/i, 'combat'],
  [/^(hit|knockback|zombiescratch)/i, 'react'],
  [/^(dance|yes$|no$|wave|idleno)/i, 'emote'],
  [/^(jog|crouch|climb|zombiewalk|walkcarry|push)/i, 'move'],
  [/^(sitting|layto|farm|fixing|interact|pickup|chest|consume|treechopping|driving)/i, 'rest'],
  [/^(idle|zombieidle|ninjajumpidle)/i, 'idle'],
  [/^(walk|run|sprint|shuffle|stealthwalk|swim|jump|fall|fly|hover|liftoff|mount|stop)/i, 'move'],
  [/^(attack|parry|dodge|shield|block|special|kick|whirlwind|fire|load|bow|deflect|hold|battleroar|roar|sheath|hipsheath)/i, 'combat'],
  [/^(ready)/i, 'idle'],
  [/^(spell|channel|cast)/i, 'magic'],
  [/^(death|dead|wound|combatwound|combatcritical|stun|knockdown|impact|drown|rise|emotedead)/i, 'react'],
  [/^(sit|sleep|kneel|loot|eat|use|fishing|emotework|emoteuse|emotesit|emotesleep|emotekneel|emoteeat)/i, 'rest'],
  [/^emote/i, 'emote'],
  [/^(stand|handsclosed|stealthstand|standhigh|npc)/i, 'idle'],
];

/** "Walk_Loop" -> "Walk"; null for bind poses. */
export function canonicalName(name) {
  if (/t_?pose/i.test(name)) return null; // bind poses are not moves
  // Snake_Case packs (Quaternius, UE-style): "Walk_Loop" -> "Walk", "Jump_Start" -> "JumpStart",
  // "Death01" -> "Death", so they line up with the moves that already exist.
  // A trailing number is kept ("Idle_2" -> "Idle2" -> "Idle 2"): in packs it's a different move.
  if (/_/.test(name)) {
    return name
      .replace(/_Loop$/i, '')
      .replace(/(\D)0\d$/, '$1')
      .split('_')
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
      .join('');
  }
  return name.replace(/_\d+$/, '').replace(/^([A-Za-z]+)0\d$/, '$1');
}

/** "EmoteTalkExclamation" -> "Talk exclamation" */
const SPECIAL_NAMES = {
  Attack2HL: 'Attack 2H light', Parry2HL: 'Parry 2H light', Ready2HL: 'Ready 2H light', Attack2HLoosePierce: 'Attack 2H pierce',
  NPCWelcome: 'NPC welcome', NPCGoodbye: 'NPC goodbye', Attack1HPierce: 'Attack 1H pierce',
};
export function prettyMove(name) {
  if (SPECIAL_NAMES[name]) return SPECIAL_NAMES[name];
  const n = name.replace(/^Emote/, '').replace(/NoSheathe$/, '').replace(/RM$/, ' (travels)').replace(/Fwd$/, ' forward').replace(/Rec$/, ' recover');
  const words = n
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Z])/g, '$1 $2')
    .replace(/\b1 H\b/, '1H')
    .replace(/\b2 H\b/, '2H')
    .split(' ');
  const s = words.join(' ').replace(/ L$/, ' (light)').replace(/2HL\b/, '2H light');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replace(/\b1h\b/g, '1H').replace(/\b2h\b/g, '2H').replace(/\bnpc\b/g, 'NPC');
}

// Free-form names (Mixamo: "StandingIdleToFightIdle", "FallingToRoll"): look for keywords
// anywhere, most specific first.
const KEYWORDS = [
  [/\b(death|dying|dead|knock|hit|stun|getting up|get up|react|impact)/, 'react'],
  [/\b(spell|cast|magic)/, 'magic'],
  [/\b(slash|sword|shield|punch|kick|attack|combo|block|dodge|roll|shoot|rifle|pistol|gun|reload|throw|boxing|fight|stab|parry|aim)/, 'combat'],
  [/\b(dance|dancing|wave|waving|cheer|salute|taunt|victory|clap|bow|laugh|yes|no|point|celebrat)/, 'emote'],
  [/\b(sit|pick|climb|push|pull|kneel|lay|sleep|open|carry|drink|eat)/, 'rest'],
  [/\b(walk|run|jog|sprint|strafe|jump|crouch|turn|swim|land|step|backward|forward|fall|stumble)/, 'move'],
  [/\b(idle|stand|breath|look)/, 'idle'],
];

export function categoryOf(canon) {
  const words = prettyMove(canon).toLowerCase(); // "Breathing idle": match whole words only
  for (const [re, c] of KEYWORDS) if (re.test(words)) return c;
  for (const [re, c] of RULES) if (re.test(canon)) return c;
  return 'other';
}

/** "Quaternius Pack 1.glb" -> "Quaternius Pack 1" */
export function sourceLabel(model) {
  return model.replace(/\.(glb|gltf)$/i, '');
}

/**
 * Group index entries ({model, url, clips:[{name, duration}]}) into moves:
 * [{ key, title, category, variants: [{model, url, clip, duration}] }]
 */
export function buildCatalog(sources) {
  const moves = new Map();
  for (const src of sources) {
    for (const c of src.clips) {
      if (c.duration <= 0) continue;
      const canon = canonicalName(c.name);
      if (!canon) continue;
      let m = moves.get(canon);
      if (!m) moves.set(canon, (m = { key: canon, title: prettyMove(canon), category: categoryOf(canon), variants: [] }));
      // keep the first clip of each model for this move (duplicates are alternates)
      if (!m.variants.some((v) => v.model === src.model)) m.variants.push({ model: src.model, url: src.url, clip: c.name, duration: c.duration, label: sourceLabel(src.model) });
    }
  }
  return [...moves.values()].sort((a, b) => a.title.localeCompare(b.title));
}
