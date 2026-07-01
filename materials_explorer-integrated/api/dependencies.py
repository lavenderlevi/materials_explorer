"""FastAPI dependency injection."""
from __future__ import annotations

import os
from functools import lru_cache

from fastapi import Depends, HTTPException, Request, status
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    mp_api_key: str = ""
    db_path: str = "materials_explorer.db"
    model_dir: str = "models"
    n_train: int = 500
    cors_origins: list[str] = ["*"]
    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_prefix="MATERIALS_",
        env_file=".env",
        extra="ignore",
    )

    def model_post_init(self, __context) -> None:
        # Also accept the legacy key name
        if not self.mp_api_key:
            self.mp_api_key = os.getenv("MP_API_KEY", "")


@lru_cache
def get_settings() -> Settings:
    return Settings()


def get_service(request: Request):
    svc = getattr(request.app.state, "service", None)
    if svc is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="MaterialsService not ready. Check MP API key and server logs.",
        )
    return svc
