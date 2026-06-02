from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://switchdex:switchdex@db:5432/switchdex"
    secret_key: str = "dev-secret-change-me"
    config_repo: str = "/data/config-repo"

    # "sim" = simulated devices; "real" = live NAPALM/Netmiko/asyncssh
    device_backend: str = "sim"

    default_ssh_username: str = "netops"
    default_ssh_password: str = ""
    default_snmp_community: str = "public"

    backup_hour: int = 2
    backup_minute: int = 0
    backup_concurrency: int = 10

    # Telemetry: sample interval (s), how long to keep raw samples (days),
    # and how long to keep downsampled hourly data (days).
    metrics_interval: int = 300
    metrics_raw_retention_days: int = 7
    metrics_hourly_retention_days: int = 90

    public_hostname: str = "localhost"

    # Auth
    jwt_alg: str = "HS256"
    token_ttl_hours: int = 12

    class Config:
        env_file = ".env"
        extra = "ignore"


settings = Settings()
