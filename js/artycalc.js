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

    return inst;
}());
