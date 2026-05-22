var artycal = (function() {
    var inst = {};

    function mils_to_radians(mils) {
        return mils * (Math.PI / 3200);
    }

    function radians_to_mils(radians) {
        return radians * (3200 / Math.PI);
    }

    function azim_mils_to_polar_radians(azim_mils) {
        // Polar coordinates are counterclockwise, so we convert to negative for clockwise,
        // and offset 1600 mils because polar 0 is the positive x axis, whereas azimuth 0 is positive y axis
        return mils_to_radians((azim_mils - 1600) * -1);
    }

    function azim_to_cart_mils(dist, azim_mils) {
        // Convert distance and azimuth (in milliradians) to cartesian coordinates
        var polar_rad = azim_mils_to_polar_radians(azim_mils);
        return {x: dist * Math.cos(polar_rad), y: dist * Math.sin(polar_rad)};
    }

    function get_translate_matrix(coords) {
        return {x: -coords.x, y: -coords.y};
    }

    function apply_translate(coords, matrix) {
        coords.x += matrix.x;
        coords.y += matrix.y;
    }

    inst.get_backcourse = function(mils) {
        return (mils >= 3200)? mils-3200 : mils+3200;
    }
    
    // Calculate the length of the opposite angles side
    // (ie: how long is the offset given an specific angle?)
    inst.getOpAngleDist = function(distance, mils) {
        return distance * Math.tan(mils_to_radians(mils));
    }
    
    // Calculate correction angle needed for a given dist
    // (i.e. how many mils to rotate to hit a corrected position)
    inst.getCorrectionAngle = function(distanceToTGT, leftRightCorrection) {
        return radians_to_mils(Math.atan(leftRightCorrection / distanceToTGT));
    }

    /**
     * @DEPRECATED
     * @DESCRIPTION - DEPRECATED! Foxhole only allows distance adjustments in 5 meter increments. Round number to the nearest multiple of five.
     * @param num Number to round
     * @returns {number}
     */
    inst.roundTo5 = function(num) {
        var ceil = Math.ceil(num / 5) * 5;
        var floor = Math.floor(num / 5) * 5;

        if (Math.abs(num - ceil) > Math.abs(num - floor)) {
            return floor;
        }
        else {
            return ceil;
        }
    };
    
    /**
     * Compute polar vector
     * 
     * @returns {dist:dist, azim:azim}
     */
    inst.cartesianToPolar = function(xa, ya, xb, yb) {
        var dx = xb - xa;
        var dy = yb - ya;

        // calculate distance from point A to point B
        var dist = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2));

        // calculate azimuth from point A to point B, in milliradians
        var azim = 0;
        if (dist > 0) {
            azim = radians_to_mils(Math.atan2(dx, dy));
            if (azim < 0) {
                azim += 6400;
            }
        }

        if (isNaN(dist) || isNaN(azim)) {
            return {error: true};
        }

        return {dist:dist, azim:azim};
    }

    /**
     * Compute distance and azimuth from artillery to target given location information relative to a spotter.
     * All azimuths are in milliradians (0-6400).
     * @param tar_dist Target distance from spotter
     * @param tar_azim Target azimuth from spotter (milliradians)
     * @param art_dist Artillery distance from spotter
     * @param art_azim Artillery azimuth from spotter (milliradians)
     * @returns {{art_tar_dist: number, art_tar_azim: number}}
     */
    inst.calc_artillery = function(tar_dist, tar_azim, art_dist, art_azim) {
        if (isNaN(tar_dist) || isNaN(tar_azim) || isNaN(art_dist) || isNaN(art_azim)) {
            return {error: true};
        }

        // convert polar coordinates of target and artillery to cartesian (azimuths in milliradians)
        var tar_coord = azim_to_cart_mils(tar_dist, tar_azim);
        var art_coord = azim_to_cart_mils(art_dist, art_azim);

        // transform cartesian coordinates to have the artillery as origin
        var translate_origin = get_translate_matrix(art_coord);
        apply_translate(tar_coord, translate_origin);
        apply_translate(art_coord, translate_origin);

        // calculate distance and azimuth from the arty to its target (result in milliradians)
        var result = inst.cartesianToPolar(art_coord.x, art_coord.y, tar_coord.x, tar_coord.y);
        return {art_tar_dist: result.dist, art_tar_azim: result.azim};
    };

    // ============================================================
    // Grid helpers
    // ============================================================

    /**
     * Expand a 6/8/10-digit grid to canonical 10-digit form by padding the
     * center of each box (the convention used elsewhere in this app).
     * Returns null for unrecognised input.
     */
    inst.expandGrid = function(raw) {
        if (raw == null) return null;
        var s = String(raw).replace(/\s+/g, '');
        if (/^\d{10}$/.test(s)) return s;
        if (/^\d{8}$/.test(s))  return s.substring(0, 4) + '5' + s.substring(4) + '5';
        if (/^\d{6}$/.test(s))  return s.substring(0, 3) + '50' + s.substring(3) + '50';
        return null;
    };

    /**
     * Human-readable label that shows the user's typed grid plus the expanded
     * canonical form if they differ.
     */
    inst.describeGrid = function(raw, expanded) {
        if (!raw) return '';
        if (raw.length === expanded.length) return raw;
        return raw + ' → ' + expanded;
    };

    /**
     * Compute a virtual 10-digit target grid from a spotter grid plus polar
     * (azim, dist). Wraps within the 0..99999 grid range like a 100km MGRS
     * square. Returns null when inputs are missing/NaN.
     */
    inst.polarToGrid = function(spotterGridExpanded, azim, dist) {
        if (!spotterGridExpanded) return null;
        if (azim == null || dist == null || isNaN(azim) || isNaN(dist)) return null;
        var sx = parseInt(spotterGridExpanded.substring(0, 5));
        var sy = parseInt(spotterGridExpanded.substring(5, 10));
        var polar_rad = (azim - 1600) * -1 * Math.PI / 3200;
        var dx = dist * Math.cos(polar_rad);
        var dy = dist * Math.sin(polar_rad);
        var tx = sx + dx;
        var ty = sy + dy;
        function pad5(n) {
            var i = Math.round(n);
            i = ((i % 100000) + 100000) % 100000;
            var s = String(i);
            while (s.length < 5) s = '0' + s;
            return s;
        }
        return pad5(tx) + pad5(ty);
    };

    // ============================================================
    // UUID helpers (display only — internal code uses raw UUIDs)
    // ============================================================

    /**
     * Derive a stable 4-digit decimal ID from a UUID for human display.
     * XOR-folds the four 32-bit words of the UUID into a single unsigned
     * 32-bit integer, then takes the first 4 digits of its decimal form.
     */
    inst.uuidToNumericId = function(uuid) {
        var hex = String(uuid).replace(/-/g, '');
        if (hex.length !== 32) return String(uuid);
        var a = parseInt(hex.substring(0,  8), 16) >>> 0;
        var b = parseInt(hex.substring(8,  16), 16) >>> 0;
        var c = parseInt(hex.substring(16, 24), 16) >>> 0;
        var d = parseInt(hex.substring(24, 32), 16) >>> 0;
        var full = ((a ^ b ^ c ^ d) >>> 0).toString();
        while (full.length < 4) full = '0' + full;
        return full.substring(0, 4);
    };

    // ============================================================
    // Fire-mission solutions
    // ============================================================

    /**
     * Initial fire mission: battery -> targetGrid. targetGrid must be the
     * canonical 10-digit form. Returns null on bad input. The slant->horizontal
     * correction using dh is preserved from the tools page; do not change
     * without coordinating with the polar calculator math.
     */
    inst.computeFireMission = function(battery, targetGrid, targetAltitude) {
        if (!battery || !/^\d{10}$/.test(targetGrid)) return null;
        var bx = parseInt(battery.grid.substring(0, 5));
        var by = parseInt(battery.grid.substring(5, 10));
        var tx = parseInt(targetGrid.substring(0, 5));
        var ty = parseInt(targetGrid.substring(5, 10));
        var batteryAlt = battery.altitude || 0;
        var targAlt = (targetAltitude == null || isNaN(targetAltitude)) ? 0 : targetAltitude;
        var polar = inst.cartesianToPolar(bx, by, tx, ty);
        if (polar.error) return null;
        var dh = targAlt - batteryAlt;
        var horizDist = polar.dist;
        if (horizDist * horizDist - dh * dh > 0) {
            horizDist = Math.sqrt(horizDist * horizDist - dh * dh);
        }
        var roundedDist = Math.round(horizDist);
        var roundedAzim = Math.round(polar.azim);
        if (roundedAzim === 6400) roundedAzim = 0;
        return {
            distance: horizDist,
            direction: polar.azim,
            targetAltitude: targAlt,
            roundedDist: roundedDist,
            roundedAzim: roundedAzim,
            rawDist: Math.round(horizDist * 100) / 100,
            rawAzim: Math.round(polar.azim * 100) / 100,
        };
    };

    /**
     * Resolve the spotter->target azimuth for adjustment math given a target-
     * shaped object. Order of precedence:
     *   1. t.spotterAzimOverride   (per-target manual compass reading)
     *   2. spotterGridExpanded + t.gridExpanded -> derive
     *   3. t.targetAzim            (the polar-mode direct measurement)
     * Returns null when no resolution path is available.
     */
    inst.resolveSpotterAzimToTarget = function(t, spotterGridExpanded) {
        if (t.spotterAzimOverride != null && !isNaN(t.spotterAzimOverride)) {
            return t.spotterAzimOverride;
        }
        if (spotterGridExpanded && t.gridExpanded) {
            var sx = parseInt(spotterGridExpanded.substring(0, 5));
            var sy = parseInt(spotterGridExpanded.substring(5, 10));
            var tx = parseInt(t.gridExpanded.substring(0, 5));
            var ty = parseInt(t.gridExpanded.substring(5, 10));
            var polar = inst.cartesianToPolar(sx, sy, tx, ty);
            if (polar && !polar.error) return polar.azim;
        }
        if (t.targetAzim != null && !isNaN(t.targetAzim)) {
            return t.targetAzim;
        }
        return null;
    };

    /**
     * Adjustment fire mission. SHIFT the target by the correction (in spotter's
     * frame), then run the same battery->target calc as the unadjusted mission.
     * Falls back to the last delivered solution (battery-relative) when neither
     * a target grid nor a current battery are available. Returns null when no
     * computation path applies (e.g. user hasn't entered a correction yet).
     */
    inst.computeAdjustedSolution = function(battery, t, spotterGridExpanded) {
        var spotterAzim = inst.resolveSpotterAzimToTarget(t, spotterGridExpanded);
        if (spotterAzim == null) return null;

        var corrX = (t.adjLR == null || isNaN(t.adjLR)) ? 0 : t.adjLR;
        var corrY = (t.adjSA == null || isNaN(t.adjSA)) ? 0 : t.adjSA;
        if (corrX === 0 && corrY === 0) return null;

        var corr = inst.cartesianToPolar(0, 0, corrX, corrY);
        if (corr.error) return null;
        // Rotate correction into spotter->target frame.
        corr.azim = spotterAzim + corr.azim;
        if (corr.azim > 6400) corr.azim -= 6400;
        if (corr.azim < 0) corr.azim += 6400;
        var polar_rad = (corr.azim - 1600) * -1 * Math.PI / 3200;
        var dx = corr.dist * Math.cos(polar_rad);
        var dy = corr.dist * Math.sin(polar_rad);

        var targAlt = (t.altitude == null || isNaN(t.altitude)) ? 0 : t.altitude;

        // Primary: absolute grid coordinates.
        if (t.gridExpanded && battery) {
            var tx = parseInt(t.gridExpanded.substring(0, 5));
            var ty = parseInt(t.gridExpanded.substring(5, 10));
            var bx = parseInt(battery.grid.substring(0, 5));
            var by = parseInt(battery.grid.substring(5, 10));
            var batteryAlt = battery.altitude || 0;
            var polar = inst.cartesianToPolar(bx, by, tx + dx, ty + dy);
            if (polar.error) return null;
            var dh = targAlt - batteryAlt;
            var horizDist = polar.dist;
            if (horizDist * horizDist - dh * dh > 0) horizDist = Math.sqrt(horizDist * horizDist - dh * dh);
            return {
                distance: horizDist, direction: polar.azim, targetAltitude: targAlt,
                roundedDist: Math.round(horizDist),
                roundedAzim: ((Math.round(polar.azim) === 6400) ? 0 : Math.round(polar.azim)),
                rawDist: Math.round(horizDist * 100) / 100,
                rawAzim: Math.round(polar.azim * 100) / 100,
            };
        }

        // Fallback: last delivered solution (battery-relative) — works when
        // battery is briefly offline or target was identified by Az+Dist.
        var latest = null;
        for (var i = t.history.length - 1; i >= 0; i--) {
            if (t.history[i].deliveredAt && t.history[i].computed) { latest = t.history[i].computed; break; }
        }
        if (!latest) return null;
        var lastAzRad = (latest.direction - 1600) * -1 * Math.PI / 3200;
        var relTx = latest.distance * Math.cos(lastAzRad);
        var relTy = latest.distance * Math.sin(lastAzRad);
        var polar2 = inst.cartesianToPolar(0, 0, relTx + dx, relTy + dy);
        if (polar2.error) return null;
        return {
            distance: polar2.dist, direction: polar2.azim, targetAltitude: targAlt,
            roundedDist: Math.round(polar2.dist),
            roundedAzim: ((Math.round(polar2.azim) === 6400) ? 0 : Math.round(polar2.azim)),
            rawDist: Math.round(polar2.dist * 100) / 100,
            rawAzim: Math.round(polar2.azim * 100) / 100,
        };
    };

    return inst;
}());
