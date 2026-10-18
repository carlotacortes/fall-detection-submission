# Real-Time Fall Detection

## How to run:

Requirements: 
- Python 3.11+
- webcam
- browser
- internet connection

Open a terminal in the project folder and run:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

1. Open **http://127.0.0.1:8000** in the browser.
2. Click **Start Camera** and allow camera access.
3. Position the camera so your full body is visible.
4. View saved events in **Event History**.
5. Click **Stop Camera** to stop detection.

Events are automatically saved in `backend/data/events.json`.

Press **Ctrl+C** in the terminal to stop the server.

## Demo

A short demonstration of the real-time fall detection system. It shows sitting down, bending over, picking up objects and then falling. 

**Note:** Recording the screen made the application slower because the Mac was running both the fall detection system and the screen recorder at the same time. Without recording, the application runs more smoothly.

https://github.com/user-attachments/assets/2ccb00f3-1e19-4603-9e00-6b784baf7710



## Files

```text
.
├── README.md                 
├── frontend/
│   ├── index.html            Page structure
│   ├── style.css             Page styling
│   ├── app.js                Camera and application coordination
│   ├── pose.js               MediaPipe body landmark estimation
│   ├── features.js           Motion measurements from landmarks
│   ├── configuration.js      Detection settings
│   ├── fallDetector.js       Fall-detection rules
│   ├── evidenceScore.js      Evidence score calculation
│   ├── scoredFallDetector.js  Adds scores to confirmed falls
│   ├── presentation.js       Status and landmark display helpers
│   ├── events.js             Sends events to the backend
│   └── history.js            Event history and filters
└── backend/
    ├── __init__.py            Python package marker
    ├── requirements.txt       Python dependencies
    ├── models.py             Event data validation
    ├── database.py           Event storage and retrieval
    └── main.py               Server and API endpoints
```
