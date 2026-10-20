-- Sean, 2026-10-20: "it's a real bummer that when I open a website in the app, there's no way for me to
-- … comment on it … while I'm looking at it … unnecessary friction that will lose people". Pages open
-- inside ButterflAI with a comment bar. frameable: the site allows being shown inside another page.
-- page_desc: what the page says it's about (its own og:description), for sites that don't.
ALTER TABLE spells ADD COLUMN frameable INTEGER;
ALTER TABLE spells ADD COLUMN page_desc TEXT;
