CREATE TABLE IF NOT EXISTS daily_api_usage (
    service TEXT NOT NULL,
    date DATE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (service, date)
);
