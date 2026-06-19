// Loading verbs for the gen-rail caption while a pane is waiting for its
// first token. Mirrors LingCode/Utils/SpinnerVerbs.swift — edit both files
// together to keep native + web copy in sync.

export const SPINNER_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Architecting', 'Baking', 'Beaming',
  "Beboppin'", 'Befuddling', 'Billowing', 'Blanching', 'Bloviating', 'Boogieing',
  'Boondoggling', 'Booping', 'Bootstrapping', 'Brewing', 'Bunning', 'Burrowing',
  'Calculating', 'Canoodling', 'Caramelizing', 'Cascading', 'Catapulting', 'Cerebrating',
  'Channeling', 'Channelling', 'Choreographing', 'Churning', 'Clauding', 'Coalescing',
  'Cogitating', 'Combobulating', 'Composing', 'Computing', 'Concocting', 'Considering',
  'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Crystallizing',
  'Cultivating', 'Deciphering', 'Deliberating', 'Determining', 'Dilly-dallying',
  'Discombobulating', 'Doing', 'Doodling', 'Drizzling', 'Ebbing', 'Effecting',
  'Elucidating', 'Embellishing', 'Enchanting', 'Envisioning', 'Evaporating', 'Fermenting',
  'Fiddle-faddling', 'Finagling', 'Flambéing', 'Flibbertigibbeting', 'Flowing', 'Flummoxing',
  'Fluttering', 'Forging', 'Forming', 'Frolicking', 'Frosting', 'Gallivanting', 'Galloping',
  'Garnishing', 'Generating', 'Gesticulating', 'Germinating', 'Gitifying', 'Grooving',
  'Gusting', 'Harmonizing', 'Hashing', 'Hatching', 'Herding', 'Honking', 'Hullaballooing',
  'Hyperspacing', 'Ideating', 'Imagining', 'Improvising', 'Incubating', 'Inferring',
  'Infusing', 'Ionizing', 'Jitterbugging', 'Julienning', 'Kneading', 'Leavening',
  'Levitating', 'Lollygagging', 'Manifesting', 'Marinating', 'Meandering', 'Metamorphosing',
  'Misting', 'Moonwalking', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Nebulizing',
  'Nesting', 'Newspapering', 'Noodling', 'Nucleating', 'Orbiting', 'Orchestrating',
  'Osmosing', 'Perambulating', 'Percolating', 'Perusing', 'Philosophising',
  'Photosynthesizing', 'Pollinating', 'Pondering', 'Pontificating', 'Pouncing',
  'Precipitating', 'Prestidigitating', 'Processing', 'Proofing', 'Propagating',
  'Puttering', 'Puzzling', 'Quantumizing', 'Razzle-dazzling', 'Razzmatazzing',
  'Recombobulating', 'Reticulating', 'Roosting', 'Ruminating', 'Sautéing', 'Scampering',
  'Schlepping', 'Scurrying', 'Seasoning', 'Shenaniganing', 'Shimmying', 'Simmering',
  'Skedaddling', 'Sketching', 'Slithering', 'Smooshing', 'Sock-hopping', 'Spelunking',
  'Spinning', 'Sprouting', 'Stewing', 'Sublimating', 'Swirling', 'Swooping', 'Symbioting',
  'Synthesizing', 'Tempering', 'Thinking', 'Thundering', 'Tinkering', 'Tomfoolering',
  'Topsy-turvying', 'Transfiguring', 'Transmuting', 'Twisting', 'Undulating', 'Unfurling',
  'Unravelling', 'Vibing', 'Waddling', 'Wandering', 'Warping', 'Whatchamacalliting',
  'Whirlpooling', 'Whirring', 'Whisking', 'Wibbling', 'Working', 'Wrangling', 'Zesting',
  'Zigzagging',
  // Extra playful / dev-adjacent (native + web stay in sync)
  'Absquatulating', 'Backpropagating', 'Bamboozling', 'Blorping', 'Brainstorming', 'Buffering',
  'Chonkifying', 'Cliffhanging', 'Diffusing', 'Dithering', 'Extrapolating', 'Filibustering',
  'Finetuning', 'Fizzing', 'Fluxing', 'Galumphing', 'Glimmering', 'Glitching', 'Hallucinating',
  'Hoisting', 'Hyperthreading', 'Immanentizing', 'Ingesting', 'JIT-compiling', 'Keysmashing',
  'Lexing', 'Linting', 'Matrix-multiplying', 'Memeing', 'Metaprompting', 'Minifying',
  'Multiplexing', 'Namespacing', 'Neologizing', 'Overthinking', 'Parsing', 'Pipelining',
  'Pixel-shifting', 'Prompt-engineering', 'Quokkaing', 'Rasterizing', 'Reasoning', 'Recursing',
  'Refactoring', 'Reprompting', 'Rubberducking', 'Sandboxing', 'Scaffolding', 'Scintillating',
  'Self-attending', 'Serializing', 'Spaghetti-ing', 'Squiggling', 'Stochastic-parroting',
  'Superpositioning', 'Swashbuckling', 'Tensoring', 'Tokenizing', 'Transpiling', 'Triangulating',
  'Turbo-encabulating', 'Type-inferring', 'Vectorizing', 'Vibe-checking', 'Wiki-walking',
  'Yak-shaving', 'Zero-indexing', 'Zip-zapping',
];

// Cadence matches the Swift native side (SpinnerVerbs.rotationInterval = 2.8s,
// MessageBubble's withAnimation easeInOut duration = 0.38s).
export const ROTATION_MS = 2800;
export const FADE_MS = 190;

export function randomWaitingLine() {
  const v = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] || 'Working';
  return `${v}…`;
}

export function nextDistinctWaitingLine(current) {
  if (SPINNER_VERBS.length <= 1) return randomWaitingLine();
  for (let i = 0; i < 16; i++) {
    const next = randomWaitingLine();
    if (next !== current) return next;
  }
  return randomWaitingLine();
}
