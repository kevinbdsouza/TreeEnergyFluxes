# Tree Energy Fluxes

This project visualises a simplified forest energy balance in 3D.  A Flask
backend performs Monte Carlo simulations of canopy, trunk, snow and soil
interactions while a Three.js front‑end renders trees and energy‑flux arrows.

## Requirements

- Python 3.9+
- `flask`, `flask-cors`, `numpy`, `scipy`

Install dependencies with:

```bash
pip install -r requirements.txt
```

(or manually install the packages above).

## Running locally

1. Start the Flask API:
   ```bash
   python app.py
   ```
   The server runs on `http://localhost:5000`.

2. Open `index.html` with any static file server or just your browser.
   The page will fetch simulation results from the API when you click
   **Sample and Run**.

## Deploying to Vercel

Vercel can host the static front‑end and a serverless Python function.
A minimal setup is:

1. Create `api/run_simulation.py` containing the contents of `app.py` but
   exporting the Flask `app` object as `app`.
2. Add a `requirements.txt` with the Python dependencies.
3. Create `vercel.json`:
   ```json
   {
     "functions": {"api/*.py": {"runtime": "python3.9"}}
   }
   ```
4. Install the [Vercel CLI](https://vercel.com/docs/cli) and run `vercel`.
   The CLI will guide you through the deployment.

The static files (`index.html` and `main.js`) will be served automatically.
The API will be available at `/api/run_simulation`.

## Repository layout

- `app.py` – Flask backend providing the Monte Carlo simulations.
- `index.html` – three.js interface with simple controls.
- `main.js` – client‑side logic, draws the trees and energy flux arrows.
- `bck/` – previous versions and development backups.

Feel free to adapt and extend the visuals or the physics model.
