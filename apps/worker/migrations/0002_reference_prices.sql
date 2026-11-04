-- API-equivalent estimate baseline from CC Switch 51fce968bca807aeee93be9420c651afb582c2c8.
-- Not a historical billing schedule. Update by adding versions; never mutate these rows.
INSERT INTO model_prices VALUES
('cc-51fce9-gemini38','gemini-3.8-flash',750000,3750000,75000,0,0,'cc-switch-51fce968','https://github.com/farion1231/cc-switch/blob/51fce968bca807aeee93be9420c651afb582c2c8/src-tauri/src/database/schema.rs'),
('cc-51fce9-gemini31','gemini-3.1-pro-preview',2000000,12000000,200000,0,0,'cc-switch-51fce968','https://github.com/farion1231/cc-switch/blob/51fce968bca807aeee93be9420c651afb582c2c8/src-tauri/src/database/schema.rs'),
('cc-51fce9-opus46','claude-opus-4-6',5000000,25000000,500000,6250000,0,'cc-switch-51fce968','https://github.com/farion1231/cc-switch/blob/51fce968bca807aeee93be9420c651afb582c2c8/src-tauri/src/database/schema.rs');
