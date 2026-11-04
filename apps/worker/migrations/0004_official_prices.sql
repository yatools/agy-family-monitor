-- Official standard text prices checked 2026-11-04. Baselines are current estimates, not historic bills.
-- Anthropic cache writes use the documented 5-minute rate; logs do not expose cache TTL.
INSERT INTO model_prices VALUES
('official-20261104-argon','gemini-4-argon',2000000,10000000,100000,2000000,0,'official-2026-11-04','https://aistudio.google.com/docs/pricing#gemini-4-argon'),
('official-20261201-argon','gemini-4-argon',4000000,20000000,200000,4000000,1796083200000,'official-2026-11-04-scheduled','https://aistudio.google.com/docs/pricing#gemini-4-argon'),
('official-20261104-flash38','gemini-3.8-flash',750000,3750000,75000,750000,0,'official-2026-11-04','https://aistudio.google.com/docs/pricing#gemini-3.8-flash'),
('official-20270101-flash38','gemini-3.8-flash',1500000,7500000,150000,1500000,1798761600000,'official-2026-11-04-scheduled','https://aistudio.google.com/docs/pricing#gemini-3.8-flash'),
('official-20261104-opus55','claude-opus-5-5',4000000,20000000,200000,5000000,0,'official-2026-11-04','https://platform.claude.com/docs/en/about-claude/pricing'),
('official-20261104-sonnet55','claude-sonnet-5-5',2000000,10000000,100000,2500000,0,'official-2026-11-04','https://platform.claude.com/docs/en/about-claude/pricing'),
('official-20261104-opus46','claude-opus-4-6',5000000,25000000,500000,6250000,0,'official-2026-11-04','https://platform.claude.com/docs/en/about-claude/pricing'),
('official-20261104-sonnet46','claude-sonnet-4-6',3000000,15000000,300000,3750000,0,'official-2026-11-04','https://platform.claude.com/docs/en/about-claude/pricing'),
('official-20261104-sonnet45','claude-sonnet-4-5',3000000,15000000,300000,3750000,0,'official-2026-11-04','https://platform.claude.com/docs/en/about-claude/pricing'),
('official-20261104-fable51','claude-fable-5-1',10000000,50000000,250000,12500000,0,'official-2026-11-04','https://platform.claude.com/docs/en/about-claude/pricing');

