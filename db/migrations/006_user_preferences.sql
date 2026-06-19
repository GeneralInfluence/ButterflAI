-- Deep user preferences for rich agent context and agent-to-agent coordination
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Dietary (critical for venue selection and agent-to-agent sharing)
  dietary_restrictions TEXT NOT NULL DEFAULT '[]',  -- JSON: ["vegetarian","gluten-free","kosher","halal","vegan"]
  food_allergies        TEXT NOT NULL DEFAULT '[]',  -- JSON: ["shellfish","peanuts","dairy"] — can be life-threatening
  cuisine_loves         TEXT NOT NULL DEFAULT '[]',  -- JSON: ["thai","italian","tacos"]
  cuisine_avoids        TEXT NOT NULL DEFAULT '[]',  -- JSON: ["sushi","spicy"]

  -- Activities
  activity_loves        TEXT NOT NULL DEFAULT '[]',  -- JSON: ["bars","live music","hiking","dinner","coffee","games"]
  activity_avoids       TEXT NOT NULL DEFAULT '[]',  -- JSON: ["clubs","karaoke"]
  vibe                  TEXT NOT NULL DEFAULT '[]',  -- JSON: ["low-key","dive bars","foodie","outdoorsy","scene-y"]

  -- Budget (per outing, USD)
  budget_low            INTEGER DEFAULT NULL,
  budget_high           INTEGER DEFAULT NULL,

  -- Location
  neighborhood          TEXT DEFAULT NULL,           -- e.g. "Mission District", "Williamsburg"
  city                  TEXT DEFAULT NULL,           -- e.g. "San Francisco"

  -- Availability (free-form, agent interprets)
  availability_notes    TEXT DEFAULT NULL,           -- "weeknight evenings after 7, weekend afternoons"

  -- Communication style
  comm_style            TEXT DEFAULT NULL,           -- "brief","detailed","just handle it"

  -- Agent notes (anything else learned conversationally)
  extra_notes           TEXT NOT NULL DEFAULT '',

  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
