const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3005;

// 60-minute cache
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

app.use(express.static(path.join(__dirname, 'public')));

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function queryFDA(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function getEventCount(searchParam) {
  const url = `https://api.fda.gov/drug/event.json?search=${searchParam}&limit=1`;
  const data = await queryFDA(url);
  return data?.meta?.results?.total ?? 0;
}

async function getTopReactions(searchParam) {
  const url = `https://api.fda.gov/drug/event.json?search=${searchParam}&count=patient.reaction.reactionmeddrapt.exact&limit=10`;
  const data = await queryFDA(url);
  if (!data?.results) return [];
  return data.results.map(r => ({ reaction: r.term, count: r.count }));
}

async function getLabelInfo(drugName) {
  const url = `https://api.fda.gov/drug/label.json?search=openfda.brand_name:"${encodeURIComponent(drugName)}"&limit=1`;
  const data = await queryFDA(url);
  if (data?.results?.[0]) {
    return data.results[0];
  }
  // Try generic name
  const url2 = `https://api.fda.gov/drug/label.json?search=openfda.generic_name:"${encodeURIComponent(drugName)}"&limit=1`;
  const data2 = await queryFDA(url2);
  return data2?.results?.[0] ?? null;
}

async function getDrugData(drugName) {
  const cacheKey = drugName.toLowerCase();
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const encodedBrand = encodeURIComponent(`patient.drug.medicinalproduct:"${drugName}"`);
  const encodedGeneric = encodeURIComponent(`patient.drug.openfda.generic_name:"${drugName}"`);

  // Run brand and generic searches in parallel for total count
  const [brandTotal, genericTotal] = await Promise.all([
    getEventCount(encodedBrand),
    getEventCount(encodedGeneric),
  ]);

  // Use whichever search term returned more results
  const bestParam = brandTotal >= genericTotal ? encodedBrand : encodedGeneric;
  const totalEvents = Math.max(brandTotal, genericTotal);

  if (totalEvents === 0) {
    return { error: 'No adverse event reports found for this drug name. Try a different spelling or the generic name.' };
  }

  const seriousParam = encodeURIComponent(`patient.drug.medicinalproduct:"${drugName}"+AND+serious:1`);
  const deathParam = encodeURIComponent(`patient.drug.medicinalproduct:"${drugName}"+AND+seriousnessdeath:1`);
  const recentParam = encodeURIComponent(`patient.drug.medicinalproduct:"${drugName}"+AND+receivedate:[20240101+TO+20251231]`);

  const seriousGenericParam = encodeURIComponent(`patient.drug.openfda.generic_name:"${drugName}"+AND+serious:1`);
  const deathGenericParam = encodeURIComponent(`patient.drug.openfda.generic_name:"${drugName}"+AND+seriousnessdeath:1`);
  const recentGenericParam = encodeURIComponent(`patient.drug.openfda.generic_name:"${drugName}"+AND+receivedate:[20240101+TO+20251231]`);

  const [
    brandSerious, genericSerious,
    brandDeath, genericDeath,
    brandRecent, genericRecent,
    topReactions,
    labelInfo,
  ] = await Promise.all([
    getEventCount(seriousParam),
    getEventCount(seriousGenericParam),
    getEventCount(deathParam),
    getEventCount(deathGenericParam),
    getEventCount(recentParam),
    getEventCount(recentGenericParam),
    getTopReactions(bestParam),
    getLabelInfo(drugName),
  ]);

  const seriousEvents = Math.max(brandSerious, genericSerious);
  const deathEvents = Math.max(brandDeath, genericDeath);
  const recentEvents = Math.max(brandRecent, genericRecent);

  let labelWarnings = null;
  if (labelInfo) {
    const warningsRaw = labelInfo.warnings?.[0] || labelInfo.warnings_and_cautions?.[0] || null;
    const adverseRaw = labelInfo.adverse_reactions?.[0] || null;
    if (warningsRaw || adverseRaw) {
      labelWarnings = {
        warnings: warningsRaw ? warningsRaw.substring(0, 1500) : null,
        adverseReactions: adverseRaw ? adverseRaw.substring(0, 1000) : null,
      };
    }
  }

  const result = {
    drug: drugName,
    totalEvents,
    seriousEvents,
    deathEvents,
    recentEvents,
    topReactions,
    labelWarnings,
  };

  setCache(cacheKey, result);
  return result;
}

app.get('/api/drug', async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) {
    return res.status(400).json({ error: 'Drug name required.' });
  }
  try {
    const data = await getDrugData(name);
    if (data.error) {
      return res.status(404).json(data);
    }
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch data from FDA.' });
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Drug Effects server running on http://localhost:${PORT}`);
  });
}
