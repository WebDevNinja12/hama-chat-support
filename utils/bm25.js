/**
 * Lightweight BM25 ranking with simple stemming and synonym groups.
 */

const STOP = new Set((
  'a an the and or but if in on at to for of is are was were be been being ' +
  'it this that these those i you he she we they me him her us them my your ' +
  'his their our what which who whom how when where why do does did done ' +
  'can could will would shall should may might must have has had having ' +
  'not no nor so as by from with about into over after before under again ' +
  'further then once here there all any both each few more most other some ' +
  'such only own same than too very just also'
).split(/\s+/));

// Concept groups so related words score together
const SYNONYMS = {
  price: 'cost', cost: 'cost', charge: 'cost', fee: 'cost', quote: 'cost',
  pricing: 'cost', estimate: 'cost', amount: 'cost', rate: 'cost',
  colour: 'color', color: 'color', colors: 'color', colours: 'color',
  paid: 'pay', payment: 'pay', paying: 'pay', pay: 'pay', payments: 'pay',
  paint: 'paint', painting: 'paint', painted: 'paint', painter: 'paint',
  interior: 'interior', exterior: 'exterior',
  design: 'design', designing: 'design',
  service: 'service', services: 'service',
  hour: 'hour', hours: 'hour', open: 'hour', time: 'hour',
  contact: 'contact', phone: 'contact', email: 'contact', call: 'contact',
  area: 'area', location: 'area', lagos: 'area', abuja: 'area',
  inspect: 'inspect', inspection: 'inspect', survey: 'inspect',
  residential: 'residential', commercial: 'commercial', industrial: 'industrial'
};

function stem(word) {
  let w = word.toLowerCase();
  if (SYNONYMS[w]) return SYNONYMS[w];
  // light suffix stripping
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (SYNONYMS[w]) return SYNONYMS[w];
  return w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function buildIndex(passages) {
  // passages: [{ id, text, docId, title }]
  const N = passages.length || 1;
  const df = new Map();
  const docs = passages.map(p => {
    const tokens = tokenize(p.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { ...p, tokens, tf, len: tokens.length };
  });
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;
  return { docs, df, N, avgdl };
}

function scoreQuery(index, queryText, k1 = 1.4, b = 0.75) {
  const qTokens = tokenize(queryText);
  if (!qTokens.length) return [];

  const uniqueQ = [...new Set(qTokens)];
  const results = [];

  for (const doc of index.docs) {
    let score = 0;
    let matched = 0;
    for (const t of uniqueQ) {
      const f = doc.tf.get(t) || 0;
      if (f > 0) matched++;
      const n = index.df.get(t) || 0;
      // IDF with smoothing; missing terms still count against coverage
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      const denom = f + k1 * (1 - b + b * (doc.len / (index.avgdl || 1)));
      score += idf * ((f * (k1 + 1)) / (denom || 1));
    }
    // Coverage: fraction of meaningful query words found
    const coverage = matched / uniqueQ.length;
    results.push({
      id: doc.id,
      docId: doc.docId,
      title: doc.title,
      text: doc.text,
      score,
      coverage,
      matched,
      queryTerms: uniqueQ.length
    });
  }

  results.sort((a, b) => b.score - a.score || b.coverage - a.coverage);
  return results;
}

module.exports = {
  tokenize,
  stem,
  buildIndex,
  scoreQuery,
  STOP,
  SYNONYMS
};
