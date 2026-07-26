platformio run -t upload
platformio device monitor

platformio run -t upload -t monitor

ssh -i "esp32-server.pem" ec2-user@ec2-13-48-132-12.eu-north-1.compute.amazonaws.com
