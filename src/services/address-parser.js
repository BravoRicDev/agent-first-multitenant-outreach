export function parseAddress(place) {
  let via = "";
  let comune = "";
  let provincia = "";
  let cap = "";

  const address = place.address || "";

  const patterns = [
    /(.*?),\s*(\d{5})\s+([^,]+?)\s*,?\s*([A-Z]{2})$/,
    /(.*?),\s*(\d{5})\s+([^,]+?)\s*,?\s+.*,\s*([A-Z]{2})$/,
    /(.*?),\s*(\d{5})\s+([^,]+?)\s+([A-Z]{2})$/,
    /(.*?),\s*(\d{5})\s+([^,\d]+?)\s*$/,
    /(.*?),\s*([^,\d]+?)\s*,?\s*([A-Z]{2})$/,
    /(.*?),\s*([^,\d]+?)\s+([A-Z]{2})$/,
    /((?:Via|Viale|Piazza|Corso|Largo|Vicolo|Borgo|Strada|Contrada|Località|Frazione)\s+[^,]+),\s*(\d{5})?\s*([^,\d]+?)\s*$/i,
  ];

  for (const regex of patterns) {
    const match = address.match(regex);
    if (match) {
      via = match[1].trim();
      if (match.length >= 4) {
        cap = (match[2] && /^\d{5}$/.test(match[2])) ? match[2].trim() : "";
        comune = /^\d{5}$/.test(match[2]) ? match[3].trim() : ((match[2] || match[3] || '')).trim();
        provincia = /^[A-Z]{2}$/.test(match[match.length - 1].trim()) ? match[match.length - 1].trim() : "";
      }
      break;
    }
  }

  if (!via) {
    via = address;
  }

  return {
    ...place,
    via,
    cap,
    comune,
    provincia,
  };
}
