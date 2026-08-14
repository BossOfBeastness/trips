// One icon set, one visual language: 24×24 grid, 1.5 stroke, round caps, no fills.
// Drawn rather than borrowed so transport, chrome and status all sit together.

const PATHS = {
  plane:    '<path d="M3.5 13.2 20 5.5a1 1 0 0 1 1.3 1.4l-4 7.3-1.6 5.6a.6.6 0 0 1-1.1.1l-2.3-4.2-4.6-1.9a.6.6 0 0 1 0-1.1z"/><path d="m12.3 15.7 4-6.6"/>',
  bus:      '<rect x="4" y="4" width="16" height="12.5" rx="2.5"/><path d="M4 10.5h16M7.5 20v-2m9 2v-2"/><circle cx="8" cy="16.5" r=".9"/><circle cx="16" cy="16.5" r=".9"/>',
  train:    '<rect x="5" y="3.5" width="14" height="12" rx="3"/><path d="M5 10h14M8.5 19.5 7 21.5m8.5-2 1.5 2M6.5 15.5h11"/>',
  ferry:    '<path d="M3.5 16.5c1.6 0 1.6 1.4 3.2 1.4s1.6-1.4 3.3-1.4 1.6 1.4 3.2 1.4 1.7-1.4 3.3-1.4 1.6 1.4 3.2 1.4"/><path d="M5 13.5 6.5 8h11L19 13.5M12 8V4.5M9 4.5h6"/>',
  car:      '<path d="M4 15.5h16M5.5 15.5V19a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-3.5m15 0V19a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-3.5"/><path d="M3.5 15.5v-3l2-5A1.5 1.5 0 0 1 7 6.5h10a1.5 1.5 0 0 1 1.4 1l2.1 5v3z"/><path d="M6.5 12h11"/>',
  transfer: '<path d="M3.5 18h2m3 0h2m3 0h2m3 0h2"/><path d="M6.5 12.5h11M6.5 12.5 9 10m-2.5 2.5L9 15m8.5-8.5h-11m11 0L15 4m2.5 2.5L15 9"/>',
  stay:     '<path d="M3.5 19v-9m0 4.5h17V19m0-3.5v-2a2 2 0 0 0-2-2H10v4"/><circle cx="6.8" cy="10.5" r="1.8"/>',
  activity: '<path d="M4 8.5a2 2 0 0 0 0 7v2.5h16V15.5a2 2 0 0 1 0-7V6H4z"/><path d="M13 6v2m0 3.5v1m0 3.5v2"/>',
  food:     '<path d="M6.5 3.5v7m0 0v10m0-10a2.5 2.5 0 0 0 2.5-2.5v-4.5m-5 0V8a2.5 2.5 0 0 0 2.5 2.5"/><path d="M17 20.5v-7c-2 0-2.8-1.3-2.8-3.5 0-3.4 1.3-6.5 2.8-6.5s2.8 3.1 2.8 6.5c0 2.2-.8 3.5-2.8 3.5z"/>',
  pin:      '<path d="M12 21s6.5-6 6.5-11a6.5 6.5 0 0 0-13 0C5.5 15 12 21 12 21z"/><circle cx="12" cy="10" r="2.4"/>',

  clock:    '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.3l3.3 2"/>',
  route:    '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8 16.2C10.5 13.5 13 12 15.8 7.8"/>',
  wallet:   '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h12a1.5 1.5 0 0 1 1.5 1.5v1"/><rect x="3.5" y="7.5" width="17" height="12" rx="2.5"/><path d="M20.5 11.5h-3.8a2.2 2.2 0 0 0 0 4.4h3.8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4m0 13.6v2.4M4.5 4.5l1.7 1.7m11.6 11.6 1.7 1.7M2.8 12h2.4m13.6 0h2.4M4.5 19.5l1.7-1.7M17.8 6.2l1.7-1.7"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  search:   '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  check:    '<path d="m5 12.5 4.5 4.5L19 7"/>',
  chevron:  '<path d="m9 5 7 7-7 7"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4m8-4v4"/>',
  share:    '<path d="M12 15.5V3.5m0 0L8 7.5m4-4 4 4"/><path d="M4.5 13v6a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-6"/>',
  inbox:    '<path d="M12 3.5v12m0 0 4-4m-4 4-4-4"/><path d="M4.5 13v6a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-6"/>',
  trash:    '<path d="M4.5 6.5h15M9.5 6.5V4.2a.7.7 0 0 1 .7-.7h3.6a.7.7 0 0 1 .7.7v2.3"/><path d="M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5"/>',
  close:    '<path d="m6 6 12 12M18 6 6 18"/>',
  alert:    '<path d="M12 8v4.8"/><circle cx="12" cy="16.3" r=".9" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="8.5"/>',
};

// `size` is the optical size; stroke stays visually constant because the grid does.
export function icon(name, { size = 20, cls = '' } = {}) {
  const d = PATHS[name] || PATHS.pin;
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${d}</svg>`;
}

/* Rousseau, "Exotic Landscape" (1910): foliage built from flat, hard-edged leaf
   shapes in many separate greens, stacked in bands with no blending or shading,
   and the whole canvas turning on a few orange fruit. Drawn the same way here —
   fixed layout, no randomness, so it never shimmers between renders. */

const LEAF = 'M0 0C7 -12 8 -27 0 -40C-8 -27 -7 -12 0 0Z';

/* The tile is 400×56 and is always drawn at that ratio, so the leaves keep their
   shape. Palest and smallest behind, darkest and largest in front — Rousseau's
   depth comes from stacking flat bands, never from shading. */
const VW = 400, VH = 56;

// [x, scale, rotation] per band. Placed by eye, fixed, never randomised.
const BANDS = [
  { fill: 'var(--pale)',   y: 50, leaves: [[6, .78, -26], [40, .62, -8], [72, .72, 14], [108, .58, -18], [146, .75, 6], [182, .64, 22], [214, .82, -12], [250, .6, 10], [284, .72, -22], [318, .65, 16], [352, .75, -6], [386, .62, 20]] },
  { fill: 'var(--frond)',  y: 53, leaves: [[22, .95, -14], [58, .78, 18], [96, .98, -4], [130, .8, -24], [166, .92, 10], [200, .74, -16], [236, .95, 20], [270, .78, -8], [304, .9, 14], [340, .74, -20], [372, .92, 4]] },
  { fill: 'var(--canopy)', y: 56, leaves: [[0, 1.12, -10], [46, .95, 16], [84, 1.08, -20], [122, .92, 8], [158, 1.12, -6], [194, .98, 22], [228, 1.05, -16], [262, .95, 12], [298, 1.12, -2], [334, .98, 18], [368, 1.08, -14], [398, .92, 6]] },
];

const FRUIT = [[64, 30], [188, 22], [296, 33]];

// `fruit` places the oranges. They are the point of the reference, so they show
// on the emptiest screen and nowhere else.
export function canopy({ fruit = false } = {}) {
  const bands = BANDS.map(b =>
    `<g fill="${b.fill}">` + b.leaves.map(([x, s, r]) =>
      `<path d="${LEAF}" transform="translate(${x} ${b.y}) rotate(${r}) scale(${s})"/>`
    ).join('') + `</g>`
  ).join('');

  const fruits = fruit
    ? FRUIT.map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="4.5" fill="var(--fruit)"/>`).join('')
    : '';

  return `<svg class="canopy" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMax meet"
    aria-hidden="true" focusable="false">${bands}${fruits}</svg>`;
}

export const ICON_FOR_MODE = {
  flight: 'plane', train: 'train', bus: 'bus', ferry: 'ferry', car: 'car', transfer: 'transfer',
};

export const ICON_FOR_TYPE = {
  transport: 'plane', stay: 'stay', activity: 'activity', food: 'food', other: 'pin',
};
