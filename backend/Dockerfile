FROM python:3.12-slim

# System deps: git for the config archive, build tools for netmiko/cryptography,
# snmp (net-snmp CLI) for the device discovery probe.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git openssh-client gcc libssl-dev snmp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Identity for git commits made by the archive engine
RUN git config --global user.email "scheduler@switchdex.local" \
 && git config --global user.name "SwitchDex Scheduler" \
 && git config --global --add safe.directory '*'

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
