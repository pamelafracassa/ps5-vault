// Supabase Edge Function: returns the "time to beat" of a PS5 game from IGDB.
// Secrets required (set them in Supabase > Edge Functions > Secrets, never in the website):
//   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET
// Call: GET /functions/v1/igdb-time?q=Astro%20Bot  ->  { found, hours, hastily, completely, count, name, igdbId, cover, coverName }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const PS5 = 167;

let token: { value: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const id = Deno.env.get('TWITCH_CLIENT_ID');
  const secret = Deno.env.get('TWITCH_CLIENT_SECRET');
  if (!id || !secret) throw new Error('missing_secrets');
  const r = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`,
    { method: 'POST' },
  );
  if (!r.ok) throw new Error('twitch_auth_' + r.status);
  const j = await r.json();
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function igdb(endpoint: string, body: string): Promise<any[]> {
  const r = await fetch('https://api.igdb.com/v4/' + endpoint, {
    method: 'POST',
    headers: {
      'Client-ID': Deno.env.get('TWITCH_CLIENT_ID')!,
      'Authorization': 'Bearer ' + (await getToken()),
      'Accept': 'application/json',
    },
    body,
  });
  if (!r.ok) throw new Error('igdb_' + endpoint + '_' + r.status);
  return await r.json();
}

const norm = (t: string) =>
  (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function rank(query: string, games: any[]) {
  const q = norm(query);
  const qt = q.split(' ').filter((w) => w.length > 1 || /\d/.test(w));
  return games
    .map((g, i) => {
      const n = norm(g.name);
      const nt = n.split(' ');
      const hit = qt.filter((w) => nt.includes(w)).length;
      if (qt.length && hit / qt.length < 0.99) return null;       // every typed word must be in the name
      let s = 10 - i * 0.2;
      if (n === q) s += 6;
      s -= Math.max(0, nt.length - qt.length) * 1.0;               // closest title wins (editions/DLC lose a little)
      if (/dlc|expansion|season pass|soundtrack|bundle/i.test(g.name)) s -= 5;
      if (g.platforms && g.platforms.includes(PS5)) s += 2;
      return { g, s };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => b.s - a.s)
    .map((x: any) => x.g);
}

function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = new URL(req.url);
    let q = url.searchParams.get('q') || '';
    if (!q && req.method === 'POST') { try { q = (await req.json()).q || ''; } catch (_) { /* ignore */ } }
    q = q.trim().slice(0, 120);
    if (q.length < 2) return json({ found: false, error: 'missing_query' }, 400);

    const esc = q.replace(/["\\]/g, ' ');
    const fields = 'fields name,platforms,first_release_date,version_parent,parent_game,cover.image_id; limit 12;';
    // PS5 first, then any platform as a fallback
    let games = await igdb('games', `search "${esc}"; ${fields} where platforms = (${PS5});`);
    if (!games.length) games = await igdb('games', `search "${esc}"; ${fields}`);
    const ranked = rank(q, games).slice(0, 5);
    if (!ranked.length) return json({ found: false });
    // official box art of the best match (3:4, ~528x748)
    const cv = ranked.find((g: any) => g.cover && g.cover.image_id);
    const cover = cv ? `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${cv.cover.image_id}.jpg` : null;
    const coverName = cv ? cv.name : null;

    // time to beat may sit on the game itself or on its "version parent" (standard edition)
    const ids = new Set<number>();
    ranked.forEach((g: any) => { ids.add(g.id); if (g.version_parent) ids.add(g.version_parent); });
    const ttb = await igdb(
      'game_time_to_beats',
      `fields game_id,hastily,normally,completely,count; where game_id = (${[...ids].join(',')}); limit 20;`,
    );
    const byId = new Map<number, any>();
    ttb.forEach((t: any) => byId.set(t.game_id, t));

    for (const g of ranked) {
      const t = byId.get(g.id) || (g.version_parent ? byId.get(g.version_parent) : null);
      if (!t) continue;
      const main = t.normally || t.completely || t.hastily || 0;     // seconds
      if (main > 0) {
        return json({
          found: true,
          hours: Math.round((main / 3600) * 10) / 10,
          hastily: t.hastily ? Math.round((t.hastily / 3600) * 10) / 10 : null,
          completely: t.completely ? Math.round((t.completely / 3600) * 10) / 10 : null,
          count: t.count || 0,
          name: g.name,
          igdbId: g.id,
          cover,
          coverName,
        });
      }
    }
    return json({ found: false, name: ranked[0].name, igdbId: ranked[0].id, cover, coverName });
  } catch (e) {
    return json({ found: false, error: String((e as Error).message || e) }, 500);
  }
});
