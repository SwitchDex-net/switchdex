"""Telemetry API — query time-series for sparklines and the full metrics view."""
from fastapi import APIRouter, Depends

from .auth import get_current_user
from . import telemetry as tel

router = APIRouter(prefix="/api/metrics", dependencies=[Depends(get_current_user)])


@router.get("/devices/{device_id}")
async def device_metric(device_id: int, metric: str = "cpu", range: str = "24h",
                        label: str = "", _: dict = Depends(get_current_user)):
    """Single metric time-series. metric: cpu|mem|reachable|if_rx|if_tx."""
    return await tel.query(device_id, metric, range, label)


@router.get("/devices/{device_id}/interfaces")
async def device_interfaces(device_id: int, range: str = "24h",
                            _: dict = Depends(get_current_user)):
    """Per-interface rx/tx throughput series."""
    return await tel.query_interfaces(device_id, range)


@router.get("/devices/{device_id}/summary")
async def device_summary(device_id: int, _: dict = Depends(get_current_user)):
    return await tel.latest_summary(device_id)


@router.get("/fleet-summary")
async def fleet_summary(_: dict = Depends(get_current_user)):
    """Latest cpu/mem/uptime for all devices, keyed by device id."""
    return await tel.fleet_summary()
