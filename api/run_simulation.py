#!/usr/bin/env python3
# --------------------------------------------------------------------------------------
#  canopy_eb_backend.py (Adapted from canopy_trunk_snow_soil_energy_v11.py)
#  ------------------------------------------------------------------------------------
#  4-node Monte-Carlo energy-balance model for a forest column
#  Adapted to run as a Flask backend for a 3-D flux visualiser.
# --------------------------------------------------------------------------------------

import json
import os
from pathlib import Path
from typing import Dict, List, Tuple, Optional, Iterable, Any

import numpy as np
from numpy.random import default_rng
from scipy.optimize import least_squares

from flask import Flask, request, jsonify
from flask_cors import CORS  # For handling Cross-Origin Resource Sharing

# --------------------------------------------------------------------------------------
#  CONSTANTS (from original script)
# --------------------------------------------------------------------------------------
SIGMA = 5.670374419e-8  # Stefan-Boltzmann       [W m-2 K-4]
RHO_AIR, CP_AIR = 1.225, 1005  # air density & cp       [kg m-3, J kg-1 K-1]
KAPPA = 0.41  # von Kármán constant
NDIM_FLUX = 100.0  # residual scaling
T_BOUNDS = (200.0, 340.0)  # solver bounds          [K]
PSYCHROMETRIC_GAMMA = 0.066  # γ  [kPa K⁻¹]
EPS = np.finfo(float).eps


# --------------------------------------------------------------------------------------
#  SIMPLE THERMODYNAMIC HELPERS (from original script)
# --------------------------------------------------------------------------------------
def esat_kPa(T: float) -> float:
    Tc = T - 273.15
    return 0.6108 * np.exp(17.27 * Tc / (Tc + 237.3))


def delta_svp_kPa_per_K(T: float) -> float:
    Tc = T - 273.15
    es = esat_kPa(T)
    return 4098.0 * es / (Tc + 237.3) ** 2


# --------------------------------------------------------------------------------------
#  AERODYNAMIC-RESISTANCE → h (from original script)
# --------------------------------------------------------------------------------------
def h_aero(u: float, z_ref: float, z0: float) -> float:
    u = max(u, 0.1)
    ra = (np.log(z_ref / z0) ** 2) / (KAPPA ** 2 * u)
    return RHO_AIR * CP_AIR / ra


# --------------------------------------------------------------------------------------
#  RADIATION HELPERS (from original script)
# --------------------------------------------------------------------------------------
def eff_emissivity(ei: float, ej: float) -> float:
    ei, ej = max(ei, EPS), max(ej, EPS)
    return 1.0 / (1.0 / ei + 1.0 / ej - 1.0)


def lw_pair(ei: float, A: float, Ti: float, ej: float, Tj: float) -> float:
    return 0.0 if A <= 0 else SIGMA * eff_emissivity(ei, ej) * A * (Ti ** 4 - Tj ** 4)


# --------------------------------------------------------------------------------------
#  PARAMETER SAMPLER (from original script)
# --------------------------------------------------------------------------------------
def sample_parameters(
        season: str = "summer",
        forest_type: str = "deciduous",
        rng: Optional[np.random.Generator] = None,
) -> Dict[str, Any]:
    rng = default_rng() if rng is None else rng
    freeze_mult = lambda T: 1.6 if T < 273.15 else 1.0

    season, forest_type = season.lower(), forest_type.lower()

    if season == "summer":
        T_atm, Q_solar = rng.uniform(293.0, 303.0), rng.uniform(400.0, 800.0)
        T_deep = T_atm + rng.uniform(-4.0, -2.0)
        k_soil, d_soil = rng.uniform(0.5, 1.5), rng.uniform(1.5, 3.0)
    else:  # winter
        T_atm, Q_solar = rng.uniform(258.0, 273.0), rng.uniform(50.0, 200.0)
        T_deep = rng.uniform(268.0, 274.0)
        k_soil, d_soil = rng.uniform(0.8, 1.3), rng.uniform(2.0, 4.0)

    RH = rng.uniform(0.60, 1.00) if season == "summer" else rng.uniform(0.70, 1.00)
    VPD = (1.0 - RH) * esat_kPa(T_atm)
    f_vpd = max(0.0, 1.0 - np.sqrt(VPD / 3.0))
    theta_rel = rng.uniform(0.40, 1.00)

    u_max = 2.0 if forest_type == "none" else 3.0
    u = rng.uniform(0.5, u_max)

    def stability_factor(u_: float) -> float:
        if season != "winter" or u_ >= 1.0: return 1.0
        return 0.3 + 0.7 * u_

    stab = stability_factor(u)
    dT_target = rng.uniform(1.0, 7.0)

    if forest_type == "coniferous":
        alpha_can = rng.uniform(0.05, 0.10)
        A_can = rng.uniform(0.5, 0.8) if season == "summer" else rng.uniform(0.4, 0.7)
        LAI = rng.uniform(3.0, 5.0)
        k_ct_base = rng.uniform(0.12, 0.25)
        k_ct = k_ct_base * freeze_mult(T_atm)
    elif forest_type == "deciduous":
        alpha_can = rng.uniform(0.15, 0.20)
        if season == "summer":
            A_can, LAI = rng.uniform(0.6, 0.9), rng.uniform(4.0, 6.0)
        else:
            A_can, LAI = rng.uniform(0.1, 0.2), rng.uniform(0.3, 0.7)
        k_ct_base = rng.uniform(0.08, 0.18)
        k_ct = k_ct_base * freeze_mult(T_atm)
    elif forest_type == "none":
        alpha_can = A_can = LAI = k_ct = 0.0
    else:
        raise ValueError(f"Unknown forest_type: {forest_type}")

    A_trunk_plan = rng.uniform(0.01, 0.05) if forest_type != "none" else 0.0
    A_trunk_vert = rng.uniform(1.0, 3.0) * A_trunk_plan if forest_type != "none" else 0.0
    k_ts, k_tsn = 0.8 * k_ct, 0.2 * k_ct

    if season == "summer":
        snow_frac = 0.0 if T_atm > 278.0 else rng.uniform(0.0, 0.05)
    else:
        snow_frac = rng.uniform(0.60, 1.00)
    A_snow = (1.0 - A_trunk_plan) * snow_frac
    A_soil = 1.0 - A_trunk_plan - A_snow
    A_snow = 0.0 if A_snow < 1e-3 else A_snow

    H_canopy = rng.uniform(10.0, 20.0) if A_can > 0 else 0.0  # ensure H_canopy is 0 if no canopy
    if A_can and H_canopy > 0:  # Added H_canopy > 0 check
        h_can_raw = h_aero(u, z_ref=H_canopy, z0=0.1 * H_canopy) * stab
        h_can = min(h_can_raw, 25.0 + 5.0 * theta_rel)
    else:
        h_can = 1e6  # effectively off if no canopy

    h_trunk = (5.0 + 4.0 * u) * stab if A_trunk_vert else 0.0
    h_soil = min(h_aero(u, 2.0, 0.01) * stab, 40.0)
    h_snow = 0.5 * h_soil

    k_ext = rng.uniform(0.4, 0.6)
    K_can = np.exp(-k_ext * LAI) if A_can else 0.0
    alpha_snow = rng.uniform(0.60, 0.90) if A_snow else 0.0
    alpha_soil = rng.uniform(0.10, 0.30)
    alpha_trunk = rng.uniform(0.15, 0.35) if A_trunk_plan else 0.0
    eps_can = rng.uniform(0.94, 1.00) if A_can else 0.0
    eps_snow = rng.uniform(0.95, 1.00) if A_snow else 0.0
    eps_soil = rng.uniform(0.90, 1.00)
    eps_trunk = rng.uniform(0.90, 0.98) if A_trunk_vert else 0.0

    Hsnow = rng.uniform(0.05, 1.0) if A_snow else 0.0
    d_ct = rng.uniform(0.05, 0.20) if (A_can and A_trunk_plan) else 0.0
    d_ts = rng.uniform(0.05, 0.10) if A_trunk_plan else 0.0
    d_tsn = rng.uniform(0.05, 0.10) if (A_trunk_plan and A_snow) else 0.0
    d_snow = max(Hsnow, 0.05) if A_snow else 0.0
    A_c2t = rng.uniform(0.03, 0.15) if (A_can and A_trunk_plan) else 0.0
    A_t2s = rng.uniform(0.01, 0.05) if A_trunk_plan else 0.0
    A_t2sn = rng.uniform(0.01, 0.05) if (A_trunk_plan and A_snow) else 0.0
    k_s = rng.uniform(0.05, 0.80) if A_snow else 0.0  # Fresh snow k can be low

    Lv, Lf, dH_photo = 2.5e6, 3.34e5, 2.8e7
    Delta = delta_svp_kPa_per_K(T_atm)
    fr_PT = Delta / (Delta + PSYCHROMETRIC_GAMMA)
    Rn_can = A_can * Q_solar * (1 - alpha_can) * (1 - K_can) if A_can > 0 else 0
    Rn_soil = A_soil * Q_solar * (1 - alpha_soil)

    def pt_mass(Rn_val):
        return 1.26 * fr_PT * max(Rn_val, 0.0) / Lv

    dot_m_vap_can = f_vpd * pt_mass(Rn_can)
    dot_m_vap_soil = f_vpd * theta_rel ** 2.0 * pt_mass(Rn_soil)
    if season == "winter":
        dot_m_vap_can *= 0.4
        dot_m_vap_soil *= 0.25
    dot_m_photo = rng.uniform(0.0, 3e-6) * A_can if season == "summer" and A_can > 0 else 0.0
    Rn_snow_proxy = A_snow * Q_solar * (1 - alpha_snow) if A_snow > 0 else 0
    dot_m_melt = 0.8 * max(Rn_snow_proxy, 0.0) / Lf if (season == "winter" and A_snow) else 0.0

    return dict(
        Q_solar=Q_solar, alpha_can=alpha_can, alpha_snow=alpha_snow,
        alpha_soil=alpha_soil, alpha_trunk=alpha_trunk, K_can=K_can,
        eps_can=eps_can, eps_snow=eps_snow, eps_soil=eps_soil, eps_trunk=eps_trunk,
        A_can=A_can, A_trunk_plan=A_trunk_plan, A_trunk_vert=A_trunk_vert,
        A_snow=A_snow, A_soil=A_soil, LAI=LAI,
        h_can=h_can, h_trunk=h_trunk, h_snow=h_snow, h_soil=h_soil,
        k_ct=k_ct, k_ts=k_ts, k_tsn=k_tsn, k_s=k_s, k_soil=k_soil,
        d_ct=d_ct, d_ts=d_ts, d_tsn=d_tsn, d_s=d_snow, d_soil=d_soil,  # d_s is d_snow
        A_c2t=A_c2t, A_t2s=A_t2s, A_t2sn=A_t2sn,
        Lv=Lv, Lf=Lf, dot_m_vap_can=dot_m_vap_can, dot_m_vap_soil=dot_m_vap_soil,
        dot_m_photo=dot_m_photo, dot_m_melt=dot_m_melt, dH_photo=dH_photo,
        RH=RH, VPD=VPD, theta_rel=theta_rel,
        T_atm=T_atm, T_deep=T_deep, season=season, forest_type=forest_type,
        Hsnow=Hsnow, u=u, dT_target=dT_target, H_canopy=H_canopy,
    )


# --------------------------------------------------------------------------------------
#  AREA OVERLAP (from original script)
# --------------------------------------------------------------------------------------
def canopy_overlap(A_can, A_snow, A_soil) -> Tuple[float, float, float]:
    ground = A_snow + A_soil
    if A_can == 0.0 or ground == 0.0: return 0.0, 0.0, 0.0
    cap = min(A_can, ground)
    return cap * (A_snow / ground), cap * (A_soil / ground), A_can - cap


# --------------------------------------------------------------------------------------
#  ENERGY-BALANCE RESIDUALS (from original script)
# --------------------------------------------------------------------------------------
def energy_balance(vars_: np.ndarray, p: Dict[str, Any]) -> np.ndarray:
    T_can, T_trunk, T_snow, T_soil = vars_
    A_can, A_tp, A_snow, A_soil = p["A_can"], p["A_trunk_plan"], p["A_snow"], p["A_soil"]
    ei, esn, esl, etr = p["eps_can"], p["eps_snow"], p["eps_soil"], p["eps_trunk"]
    A_can_snow, A_can_soil, _ = canopy_overlap(A_can, A_snow, A_soil)
    A_snow_sky, A_soil_sky = A_snow - A_can_snow, A_soil - A_can_soil
    eps_atm = min(0.9, 0.8 + 0.2 * np.tanh((p["T_atm"] - 260.0) / 15.0))
    LW_down = eps_atm * SIGMA * p["T_atm"] ** 4
    lw = lambda T: SIGMA * T ** 4
    Q = p["Q_solar"]
    gap = 1.0 - min(A_can, 1.0)
    SW_trans = A_can * Q * (1 - p["alpha_can"]) * p["K_can"] if A_can else 0.0
    SW_can_abs = A_can * Q * (1 - p["alpha_can"]) * (1 - p["K_can"]) if A_can else 0.0
    SW_trunk_dir = gap * A_tp * Q * (1 - p["alpha_trunk"]) if A_tp else 0.0
    SW_trunk_can = A_tp * SW_trans * (1 - p["alpha_trunk"]) if A_tp else 0.0
    SW_snow_dir = A_snow_sky * Q * (1 - p["alpha_snow"]) if A_snow else 0.0
    SW_snow_can = A_can_snow * SW_trans * (1 - p["alpha_snow"]) if A_snow else 0.0
    SW_soil_dir = A_soil_sky * Q * (1 - p["alpha_soil"])
    SW_soil_can = A_can_soil * SW_trans * (1 - p["alpha_soil"])
    F_can_snow = lw_pair(ei, A_can_snow * np.exp(-0.5 * p["LAI"]), T_can, esn, T_snow) if A_can and A_snow else 0.0
    F_can_soil = lw_pair(ei, A_can_soil * np.exp(-0.5 * p["LAI"]), T_can, esl, T_soil) if A_can else 0.0
    cond_can_trunk = (p["k_ct"] * p["A_c2t"] / max(p["d_ct"], EPS)) * (T_can - T_trunk) if p["A_c2t"] else 0.0
    cond_trunk_soil = (p["k_ts"] * p["A_t2s"] / max(p["d_ts"], EPS)) * (T_trunk - T_soil) if p["A_t2s"] else 0.0
    if p["A_t2sn"] and A_snow:
        R_cond = p["d_tsn"] / max(p["k_tsn"], EPS) + p["d_s"] / max(p["k_s"], EPS)  # d_s is d_snow
        cond_trunk_snow = p["A_t2sn"] * (T_trunk - T_snow) / max(R_cond, EPS)
    else:
        cond_trunk_snow = 0.0
    cond_snow_soil = (p["k_s"] * A_snow / max(p["d_s"], EPS)) * (T_snow - T_soil) if A_snow else 0.0  # d_s is d_snow
    A_ground = A_soil + A_snow
    cond_soil_deep = A_ground * p["k_soil"] / max(p["d_soil"], EPS) * (T_soil - p["T_deep"]) if A_ground else 0.0
    F_trunk_sky = 0.4 if A_can > 0 else 1.0
    LW_can_atm = ei * A_can * (LW_down - lw(T_can)) if A_can else 0.0
    LW_trunk_atm = etr * p["A_trunk_vert"] * F_trunk_sky * (LW_down - lw(T_trunk)) if p["A_trunk_vert"] else 0.0
    LW_snow_atm = esn * A_snow_sky * (LW_down - lw(T_snow)) if A_snow else 0.0
    LW_soil_atm = esl * A_soil_sky * (LW_down - lw(T_soil))
    conv_can_atm = p["h_can"] * A_can * (T_can - p["T_atm"]) if A_can else 0.0
    conv_trunk_atm = p["h_trunk"] * p["A_trunk_vert"] * (T_trunk - p["T_atm"]) if p["A_trunk_vert"] else 0.0
    conv_snow_atm = p["h_snow"] * A_snow * (T_snow - p["T_atm"]) if A_snow else 0.0
    conv_soil_atm = p["h_soil"] * A_soil * (T_soil - p["T_atm"])
    evap_can = p["Lv"] * p["dot_m_vap_can"] if A_can else 0.0
    evap_soil = p["Lv"] * p["dot_m_vap_soil"]
    photo_can = p["dH_photo"] * p["dot_m_photo"] if A_can else 0.0
    melt_snow = p["Lf"] * p["dot_m_melt"] if (A_snow and T_snow >= 273.15) else 0.0
    f_can = ((
                         SW_can_abs - F_can_snow - F_can_soil + LW_can_atm - cond_can_trunk - conv_can_atm - evap_can - photo_can) / NDIM_FLUX) if A_can else (
                T_can - p["T_atm"])
    f_trunk = ((
                           SW_trunk_dir + SW_trunk_can + LW_trunk_atm + cond_can_trunk - cond_trunk_soil - cond_trunk_snow - conv_trunk_atm) / NDIM_FLUX) if A_tp else (
                T_trunk - p["T_atm"])
    f_snow = ((
                          SW_snow_dir + SW_snow_can + F_can_snow + LW_snow_atm + cond_trunk_snow - cond_snow_soil - conv_snow_atm - melt_snow) / NDIM_FLUX) if A_snow else (
                T_snow - p["T_atm"])  # if no snow, T_snow should ideally track T_atm or T_soil
    f_soil = (
                         SW_soil_dir + SW_soil_can + F_can_soil + LW_soil_atm + cond_trunk_soil + cond_snow_soil - conv_soil_atm - cond_soil_deep - evap_soil) / NDIM_FLUX
    return np.array([f_can, f_trunk, f_snow, f_soil])


# --------------------------------------------------------------------------------------
#  DIAGNOSTIC-FLUX BREAKDOWN (from original script)
# --------------------------------------------------------------------------------------
def compute_flux_components(vars_: np.ndarray, p: Dict[str, Any]) -> Dict[str, Dict[str, float]]:
    T_can, T_trunk, T_snow, T_soil = vars_
    A_can, A_tp, A_tv = p["A_can"], p["A_trunk_plan"], p["A_trunk_vert"]
    A_snow, A_soil = p["A_snow"], p["A_soil"]
    ei, esn, esl, etr = p["eps_can"], p["eps_snow"], p["eps_soil"], p["eps_trunk"]
    A_can_snow, A_can_soil, _ = canopy_overlap(A_can, A_snow, A_soil)
    A_snow_sky, A_soil_sky = A_snow - A_can_snow, A_soil - A_can_soil
    A_can_snow_eff = A_can_snow * np.exp(-0.5 * p["LAI"]) if A_can and A_snow else 0.0
    A_can_soil_eff = A_can_soil * np.exp(-0.5 * p["LAI"]) if A_can else 0.0
    eps_atm = min(0.9, 0.8 + 0.2 * np.tanh((p["T_atm"] - 260.0) / 15.0))
    LW_down = eps_atm * SIGMA * p["T_atm"] ** 4
    lw = lambda T: SIGMA * T ** 4
    Q = p["Q_solar"]
    gap = 1.0 - min(A_can, 1.0)
    SW_tr = A_can * Q * (1 - p["alpha_can"]) * p["K_can"] if A_can else 0.0
    SW_abs = A_can * Q * (1 - p["alpha_can"]) * (1 - p["K_can"]) if A_can else 0.0
    SW_trunk_dir = gap * A_tp * Q * (1 - p["alpha_trunk"]) if A_tp else 0.0
    SW_trunk_can = A_tp * SW_tr * (1 - p["alpha_trunk"]) if A_tp else 0.0
    SW_snow_dir = A_snow_sky * Q * (1 - p["alpha_snow"]) if A_snow else 0.0
    SW_snow_can = A_can_snow * SW_tr * (1 - p["alpha_snow"]) if A_snow else 0.0
    SW_soil_dir = A_soil_sky * Q * (1 - p["alpha_soil"])
    SW_soil_can = A_can_soil * SW_tr * (1 - p["alpha_soil"])
    F_can_snow = lw_pair(ei, A_can_snow_eff, T_can, esn, T_snow)
    F_can_soil = lw_pair(ei, A_can_soil_eff, T_can, esl, T_soil)
    cond_can_trunk = p["k_ct"] * p["A_c2t"] / max(p["d_ct"], EPS) * (T_can - T_trunk) if p["A_c2t"] else 0.0
    cond_trunk_soil = (p["k_ts"] * p["A_t2s"] / max(p["d_ts"], EPS) * (T_trunk - T_soil)) if p["A_t2s"] else 0.0
    if p["A_t2sn"] and A_snow:
        R_cond = p["d_tsn"] / max(p["k_tsn"], EPS) + p["d_s"] / max(p["k_s"], EPS)
        cond_trunk_snow = p["A_t2sn"] * (T_trunk - T_snow) / max(R_cond, EPS)
    else:
        cond_trunk_snow = 0.0
    cond_snow_soil = p["k_s"] * A_snow / max(p["d_s"], EPS) * (T_snow - T_soil) if A_snow else 0.0
    A_ground = A_soil + A_snow
    cond_soil_deep = A_ground * p["k_soil"] / max(p["d_soil"], EPS) * (T_soil - p["T_deep"]) if A_ground else 0.0
    F_trunk_sky = 0.4 if A_can > 0 else 1.0
    LW_can_atm = ei * A_can * (LW_down - lw(T_can)) if A_can else 0.0
    LW_trunk_atm = etr * A_tv * F_trunk_sky * (LW_down - lw(T_trunk)) if A_tv else 0.0
    LW_snow_atm = esn * A_snow_sky * (LW_down - lw(T_snow)) if A_snow else 0.0
    LW_soil_atm = esl * A_soil_sky * (LW_down - lw(T_soil))
    conv_can_atm = p["h_can"] * A_can * (T_can - p["T_atm"]) if A_can else 0.0
    conv_trunk_atm = p["h_trunk"] * A_tv * (T_trunk - p["T_atm"]) if A_tv else 0.0
    conv_snow_atm = p["h_snow"] * A_snow * (T_snow - p["T_atm"]) if A_snow else 0.0
    conv_soil_atm = p["h_soil"] * A_soil * (T_soil - p["T_atm"])
    evap_can = p["Lv"] * p["dot_m_vap_can"] if A_can else 0.0
    evap_soil = p["Lv"] * p["dot_m_vap_soil"]
    photo_can = p["dH_photo"] * p["dot_m_photo"] if A_can else 0.0
    melt_snow = p["Lf"] * p["dot_m_melt"] if (A_snow and T_snow >= 273.15) else 0.0
    flux: Dict[str, Dict[str, float]] = {}
    if A_can:
        flux["canopy"] = {"SW_abs": SW_abs, "LW_atm": LW_can_atm, "LW_to_snow": -F_can_snow, "LW_to_soil": -F_can_soil,
                          "conv_atm": -conv_can_atm, "cond_to_trunk": -cond_can_trunk, "latent_evap": -evap_can,
                          "latent_photo": -photo_can}
        flux["canopy"]["net"] = sum(flux["canopy"].values())
    if A_tp:  # A_tp for trunk plan area, A_tv for vertical/convective area
        flux["trunk"] = {"SW_dir": SW_trunk_dir, "SW_can": SW_trunk_can, "LW_atm": LW_trunk_atm,
                         "cond_from_can": cond_can_trunk, "cond_to_soil": -cond_trunk_soil,
                         "cond_to_snow": -cond_trunk_snow, "conv_atm": -conv_trunk_atm}
        flux["trunk"]["net"] = sum(flux["trunk"].values())
    if A_snow:
        flux["snow"] = {"SW_dir": SW_snow_dir, "SW_can": SW_snow_can, "LW_atm": LW_snow_atm, "LW_from_can": F_can_snow,
                        "cond_from_trunk": cond_trunk_snow, "cond_to_soil": -cond_snow_soil, "conv_atm": -conv_snow_atm,
                        "melt_sink": -melt_snow}
        flux["snow"]["net"] = sum(flux["snow"].values())
    flux["soil"] = {"SW_dir": SW_soil_dir, "SW_can": SW_soil_can, "LW_atm": LW_soil_atm, "LW_from_can": F_can_soil,
                    "cond_from_trunk": cond_trunk_soil, "cond_from_snow": cond_snow_soil, "conv_atm": -conv_soil_atm,
                    "latent_evap": -evap_soil, "cond_to_deep": -cond_soil_deep}
    flux["soil"]["net"] = sum(flux["soil"].values())
    return flux


# --------------------------------------------------------------------------------------
#  SIMPLE UTILITIES (from original script)
# --------------------------------------------------------------------------------------
def average_flux_dicts(dicts: Iterable[Dict[str, Dict[str, float]]]
                       ) -> Dict[str, Dict[str, float]]:
    out: Dict[str, Dict[str, float]] = {};
    n = 0
    for d_item in dicts:  # renamed d to d_item to avoid conflict
        n += 1
        for node, comps in d_item.items():
            tgt = out.setdefault(node, {})
            for k, v_val in comps.items():  # renamed v to v_val
                tgt[k] = tgt.get(k, 0.0) + v_val
    if n:
        for node in out:
            for k in out[node]:
                out[node][k] /= n
    return out


# --------------------------------------------------------------------------------------
#  MONTE-CARLO DRIVER (from original script)
# --------------------------------------------------------------------------------------
def run_monte_carlo(n_runs: int = 100,  # Renamed n to n_runs
                    season: str = "summer",
                    forest_type: str = "deciduous",
                    maxiter: int = 2500,  # Reduced from 2500 in original example to 500 for speed
                    seed: Optional[int] = None
                    ) -> Tuple[List[np.ndarray], List[Dict[str, Any]]]:  # Removed soil_T return
    rng = default_rng(seed)
    sols_list, pars_list = [], []  # Renamed sols to sols_list, pars to pars_list
    for _ in range(n_runs):
        p = sample_parameters(season, forest_type, rng)
        T_atm, T_deep = p["T_atm"], p["T_deep"]
        has_snow = p["A_snow"] > 0.0

        # Sensible initial guess based on atmospheric and deep soil temperatures
        guess = np.array([
            T_atm + (rng.uniform(1.0, 8.0) if season == "summer" else rng.uniform(-2.0, 5.0)),  # T_can
            (T_atm + T_deep) / 2.0 + rng.uniform(-3.0, 3.0),  # T_trunk
            273.15 if (has_snow and T_atm < 275.0) else (T_atm - rng.uniform(1.0, 10.0)),  # T_snow
            T_deep + rng.uniform(-2.0, 4.0)  # T_soil
        ])
        # Ensure T_snow guess is not too high if no snow or summer
        if not has_snow: guess[2] = (guess[0] + guess[3]) / 2  # intermediate if no snow
        if season == "summer" and has_snow: guess[2] = min(guess[2], 273.15 + rng.uniform(0, 0.1))

        res = least_squares(
            energy_balance, guess, bounds=T_BOUNDS,
            args=(p,), loss="soft_l1", f_scale=1.0, max_nfev=maxiter, ftol=1e-4, xtol=1e-4, gtol=1e-4
        )
        if not (res.success and np.all(np.abs(res.fun) < 5e-3)):  # Looser convergence for speed
            continue
        if abs(res.x[3] - T_atm) > 20.0:  # Looser QC for T_soil vs T_atm
            continue
        sols_list.append(res.x);
        pars_list.append(p)

    return sols_list, pars_list


# --------------------------------------------------------------------------------------
#  Flask App Setup
# --------------------------------------------------------------------------------------
app = Flask(__name__)
CORS(app)  # Enable CORS for all routes


@app.route('/api/run_simulation', methods=['POST'])
def handle_run_simulation():
    try:
        data = request.get_json()
        season_str = data.get('season', 'summer')
        forest_type_str = data.get('forest_type', 'deciduous')

        # Run Monte Carlo simulation (using a smaller n for responsiveness)
        # Seed is None for variability on each call
        sols_list, pars_list = run_monte_carlo(
            n_runs=100,  # Number of simulations to average for one API call
            season=season_str,
            forest_type=forest_type_str,
            seed=None
        )

        if not pars_list:  # No successful simulation runs
            return jsonify({"error": "No successful simulation runs converged. Try again."}), 500

        # Use parameters from the first successful run for geometry representation
        p_representative = pars_list[0]

        # Calculate average temperatures from all successful runs
        if sols_list:
            avg_temps_solved = np.mean(np.array(sols_list), axis=0)
        else:  # Should not happen if pars_list is not empty, but as a fallback
            avg_temps_solved = np.array([p_representative["T_atm"]] * 4)

        temperatures_json = {
            "air": p_representative["T_atm"],
            "canopy": float(avg_temps_solved[0]),
            "trunk": float(avg_temps_solved[1]),
            "snow": float(avg_temps_solved[2]) if p_representative["A_snow"] > 0 else None,
            "soil": float(avg_temps_solved[3])
        }

        # Compute all flux components for each successful run and then average them
        all_run_fluxes = [compute_flux_components(s, p_run) for s, p_run in zip(sols_list, pars_list)]
        averaged_fluxes_json = average_flux_dicts(all_run_fluxes)

        # Ensure all flux values are serializable (convert numpy floats if any)
        for node_fluxes in averaged_fluxes_json.values():
            for key, value in node_fluxes.items():
                node_fluxes[key] = float(value)

        # Prepare the 'parameters' part of the JSON, mirroring JS `sampleParams` structure
        # These keys are what the JS side's buildColumn and UI elements might expect.
        parameter_keys_for_js = [
            "season", "forest_type", "Q_solar", "alpha_can", "A_can", "LAI",
            "H_canopy", "A_trunk_plan", "A_trunk_vert", "A_snow", "Hsnow", "A_soil",
            "T_atm", "T_deep", "u"
        ]
        parameters_json = {
            key: p_representative.get(key) for key in parameter_keys_for_js
        }
        # Ensure values are Python native types for JSON serialization if they came from numpy
        for key, value in parameters_json.items():
            if isinstance(value, (np.float32, np.float64)):
                parameters_json[key] = float(value)
            elif isinstance(value, (np.int32, np.int64)):
                parameters_json[key] = int(value)

        response_data = {
            "parameters": parameters_json,
            "temperatures": temperatures_json,
            "fluxes": averaged_fluxes_json
        }
        return jsonify(response_data)

    except Exception as e:
        app.logger.error(f"Error in /api/run_simulation: {str(e)}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    # Make sure to run this with `python app.py`
    # The frontend fetch URL should be like `http://localhost:5000/api/run_simulation`
    app.run(debug=True, port=5000)
