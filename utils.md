---
---

---

---

platformio run -t upload
platformio device monitor

platformio run -t upload -t monitor

---

---

---

---

ssh -i "esp32-server.pem" ec2-user@ec2-13-48-132-12.eu-north-1.compute.amazonaws.com

scp -i "C:\Users\sesil\Downloads\WatchAir\server\esp32-server.pem" "C:\Users\sesil\Downloads\WatchAir\server\app\main.py" ec2-user@ec2-13-48-132-12.eu-north-1.compute.amazonaws.com:~/watchair_server/app/main.py

uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

pkill -f uvicorn
