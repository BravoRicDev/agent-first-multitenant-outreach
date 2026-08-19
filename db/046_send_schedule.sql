CREATE TABLE IF NOT EXISTS send_schedule (
  id       SERIAL PRIMARY KEY,
  dow      INT NOT NULL CHECK (dow BETWEEN 0 AND 6),
  hour     INT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  allowed  BOOLEAN DEFAULT true,
  UNIQUE(dow, hour)
);

INSERT INTO send_schedule (dow, hour, allowed) VALUES
  (1,8,true),(1,9,true),(1,10,true),(1,11,true),(1,12,true),(1,13,true),(1,14,true),(1,15,true),(1,16,true),(1,17,true),
  (2,8,true),(2,9,true),(2,10,true),(2,11,true),(2,12,true),(2,13,true),(2,14,true),(2,15,true),(2,16,true),(2,17,true),
  (3,8,true),(3,9,true),(3,10,true),(3,11,true),(3,12,true),(3,13,true),(3,14,true),(3,15,true),(3,16,true),(3,17,true),
  (4,8,true),(4,9,true),(4,10,true),(4,11,true),(4,12,true),(4,13,true),(4,14,true),(4,15,true),(4,16,true),(4,17,true),
  (5,8,true),(5,9,true),(5,10,true),(5,11,true),(5,12,true),(5,13,true),(5,14,true),(5,15,true),(5,16,true),(5,17,true)
ON CONFLICT DO NOTHING;
