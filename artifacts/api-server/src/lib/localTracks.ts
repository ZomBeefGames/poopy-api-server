export interface LocalTrack {
  slug: string;
  title: string;
  duration: number;
  artwork: string | null;
}

function slugToTitle(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const TRACK_DURATIONS: Record<string, number> = {
  "a-love-we-cant-keep": 249.391020,
  "big-tiddy-bitches": 124.160000,
  "captain-save-a-hoe": 149.524898,
  "cut-clean": 151.849796,
  "das-backwards-1": 196.649796,
  "devil-on-the-line-1": 152.764082,
  "di-sf": 186.749388,
  "duffle-bag-mansion": 130.795102,
  "fallen-echoes-mp3": 189.988571,
  "fragments-v2": 249.887347,
  "glass-veins": 229.799184,
  "high-risk-high-fashion": 125.988571,
  "high-risk-high-fashion-v-2": 123.193469,
  "might-go": 190.328163,
  "mountain-of-regrets": 243.173878,
  "no-pulse": 167.079184,
  "no-signal": 184.790204,
  "on-the-prowl-in-the-trap": 157.152653,
  "rage-check": 89.887347,
  "raised-this-way": 193.750204,
  "raised-this-way-v-3": 189.884082,
  "scarred-and-seamed": 232.803265,
  "scat-on-the-dancefloor": 142.315102,
  "slowbro-still-go": 123.193469,
  "smiling-anyways-remix": 399.229388,
  "stitched-up": 202.840816,
  "too-high-to-die-today-1": 169.247347,
  "too-sick": 232.202449,
  "worn-thin-remastered": 207.307755,
};

const TRACK_ARTWORK: Record<string, string> = {
  "captain-save-a-hoe": "https://i1.sndcdn.com/artworks-zWfmcLHjojWOBChA-EnzxGw-t500x500.jpg",
  "high-risk-high-fashion-v-2": "https://i1.sndcdn.com/artworks-lbR4KPox3o97J5RP-ofOxYw-t500x500.jpg",
  "mountain-of-regrets": "https://i1.sndcdn.com/artworks-AoxnMxl8GhfslvPg-LbCDpg-t500x500.jpg",
  "high-risk-high-fashion": "https://i1.sndcdn.com/artworks-8sQA6l0g4tiNu0uE-Vow2cw-t500x500.jpg",
  "devil-on-the-line-1": "https://i1.sndcdn.com/artworks-XhmC19viz3zhGvY6-TFuXMg-t500x500.jpg",
  "scat-on-the-dancefloor": "https://i1.sndcdn.com/artworks-56qfQOQbVcF8Ri6E-qY1Rug-t500x500.jpg",
  "a-love-we-cant-keep": "https://i1.sndcdn.com/artworks-fV7U3FSYbjJJYpjB-2p74BA-t500x500.jpg",
  "raised-this-way-v-3": "https://i1.sndcdn.com/artworks-TGqs6YkXP8BSOBll-YiwUzg-t500x500.jpg",
  "slowbro-still-go": "https://i1.sndcdn.com/artworks-mfPonjxwq3Omq0fd-uF7Yhg-t500x500.jpg",
  "raised-this-way": "https://i1.sndcdn.com/artworks-KEVhDDWSm2Tqlp8d-ymuesw-t500x500.jpg",
  "das-backwards-1": "https://i1.sndcdn.com/artworks-C740GZCY7Q5wXdiE-b9nrQQ-t500x500.jpg",
  "on-the-prowl-in-the-trap": "https://i1.sndcdn.com/artworks-0Cl6AH6jL5bIcHQJ-oKxjUA-t500x500.jpg",
  "di-sf": "https://i1.sndcdn.com/artworks-FBg6XQFM9kyguJw1-PTFaEw-t500x500.jpg",
  "fallen-echoes-mp3": "https://i1.sndcdn.com/artworks-RyVK61lb8UwWowu7-YPpztg-t500x500.jpg",
  "scarred-and-seamed": "https://i1.sndcdn.com/artworks-nbarnNINvveCDMH9-vLHJmQ-t500x500.jpg",
  "duffle-bag-mansion": "https://i1.sndcdn.com/artworks-t7F3mDfB3UUh53iD-hFWpJg-t500x500.jpg",
  "glass-veins": "https://i1.sndcdn.com/artworks-eMuEkJDLYZR9wnsY-M27ZuQ-t500x500.jpg",
  "might-go": "https://i1.sndcdn.com/artworks-2xXybJvKd7UhAJSp-B4fa0w-t500x500.jpg",
  "rage-check": "https://i1.sndcdn.com/artworks-OjIBQh9fz7ERZMnQ-ahzzmA-t500x500.jpg",
  "too-high-to-die-today-1": "https://i1.sndcdn.com/artworks-9nZyb8tCKyVFT8pp-VT53eA-t500x500.jpg",
  "stitched-up": "https://i1.sndcdn.com/artworks-P7KsC1cyvoMXaCYD-NPPCQw-t500x500.jpg",
  "smiling-anyways-remix": "https://i1.sndcdn.com/artworks-Ufm9Ws3gEXkogxvx-MwjYqg-t500x500.jpg",
  "too-sick": "https://i1.sndcdn.com/artworks-luIjlzKUyegu4bzn-vAVybw-t500x500.jpg",
  "no-pulse": "https://i1.sndcdn.com/artworks-coXBwqtsTXW8qvqY-ZzIPOQ-t500x500.jpg",
  "cut-clean": "https://i1.sndcdn.com/artworks-iZr7QHObDJoxbPZT-D9sgTA-t500x500.jpg",
  "worn-thin-remastered": "https://i1.sndcdn.com/artworks-8KUHKMBV5folsdHx-Xizzxw-t500x500.jpg",
  "big-tiddy-bitches": "https://i1.sndcdn.com/artworks-WuCzNqdcrx2RL24p-wF7ENQ-t500x500.jpg",
  "no-signal": "https://i1.sndcdn.com/artworks-MBiHuhSMuud9CtCA-pEniFg-t500x500.jpg",
  "fragments-v2": "https://i1.sndcdn.com/artworks-coXBwqtsTXW8qvqY-ZzIPOQ-t500x500.jpg",
};

export function getLocalTracks(): LocalTrack[] {
  return Object.keys(TRACK_DURATIONS).map((slug) => ({
    slug,
    title: slugToTitle(slug),
    duration: TRACK_DURATIONS[slug],
    artwork: TRACK_ARTWORK[slug] ?? null,
  }));
}

export function getLocalTrackBySlug(slug: string): LocalTrack | null {
  const duration = TRACK_DURATIONS[slug];
  if (duration === undefined) return null;
  return {
    slug,
    title: slugToTitle(slug),
    duration,
    artwork: TRACK_ARTWORK[slug] ?? null,
  };
}
