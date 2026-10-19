// functions/api/app/_ky26-gumbai.js
// Gumbai's authored Kyushu 2026 banzuke picks (the pace car). Gumbai never POSTs to the member
// endpoint, so its live-basho picks are handed to the loader as a module (shape matches a KV player:
// { key, name, ranks:{Name:code}, bonus:[] }). Wire in _targets.js: import this and set it as the
// Kyushu target's `gumbai`. Gumbai SITS OUT the juryo-promotion bonus (bonus:[]), same as Aki.
export default {
  key: 'gumbai',
  name: 'Gumbai',
  ranks: {
    Onosato: 'y', Hoshoryu: 'y',
    Kirishima: 'o', Aonishiki: 'o', Kotozakura: 'o',
    Atamifuji: 's', Fujinokawa: 's',
    Yoshinofuji: 'k', Churanoumi: 'k',
    Daieisho: 'm4', Hakunofuji: 'm4', Kotoshoho: 'm4', Fujiseiun: 'm4', Ura: 'm4',
    Takayasu: 'm3', Fujiryoga: 'm3',
    Hiradoumi: 'm5', Takerufuji: 'm5',
    Kotoeiho: 'm6', Gonoyama: 'm6', Wakamotoharu: 'm6',
    Kinbozan: 'm7',
    Oshoma: 'm8', Roga: 'm8', Nishikifuji: 'm8',
    Takanosho: 'm10', Shishi: 'm10', Asakoryu: 'm10',
    Oho: 'm11', Asahakuryu: 'm11',
    Abi: 'm12',
    Ichiyamamoto: 'm13', Toshinofuji: 'm13',
    Tokihayate: 'm14', Asasuiryu: 'm14',
    Asanoyama: 'm1',
    Shodai: 'j', Wakatakakage: 'j', Tobizaru: 'j', Chiyoshoma: 'j', Wakanosho: 'j', Shonannoumi: 'j',
  },
  bonus: [],
};
