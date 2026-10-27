// Shared cache in front of the data APIs. Fossil records and geology rarely change, so Vercel's CDN keeps each
// answer for 4 days and every visitor reuses it; the APIs see one request per URL per refresh.
export const config = { runtime: "edge" };

const ALLOWED = [
  "https://api.gbif.org/v1/occurrence/search?",
  "https://api.gbif.org/v1/species/",
  "https://en.wikipedia.org/w/api.php?",
  "https://paleobiodb.org/data1.2/",
  "https://macrostrat.org/api/v2/mobile/map_query?",
  "https://data-gis.unep-wcmc.org/server/rest/services/ProtectedSites/The_World_Database_of_Protected_Areas/MapServer/1/query?",
  "https://nominatim.openstreetmap.org/reverse?",
];
const FRESH = 4 * 24 * 3600; // 4 days
const STALE = 2 * 24 * 3600; // after that, serve the old copy while refreshing in the background

export default async function handler(req) {
  const target = new URL(req.url).searchParams.get("url") || "";
  if (!ALLOWED.some((p) => target.startsWith(p))) {
    return new Response("Not allowed", { status: 400 });
  }
  let upstream;
  try {
    upstream = await fetch(target, {
      headers: { "User-Agent": "FossilTrace/0.1 (https://fossiltrace.vercel.app)", Accept: "application/json" },
    });
  } catch (err) {
    return new Response("Upstream unreachable", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (upstream.ok) {
    headers["Cache-Control"] = `public, max-age=3600, s-maxage=${FRESH}, stale-while-revalidate=${STALE}`;
  } else {
    headers["Cache-Control"] = "no-store"; // never cache a 429 or an outage
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
