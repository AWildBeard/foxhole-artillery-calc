/**
 * util.js — general-purpose helpers shared across the spotter / artillery
 * client and the broker UI. Anything pure, app-shape-agnostic, and reusable
 * across views belongs here. App-specific rendering stays in index.html;
 * pure math stays in artycalc.js.
 */
var util = (function() {
    var inst = {};

    /**
     * HTML-escape a value so it can be safely interpolated into innerHTML.
     * Covers the OWASP "fundamental five" entities — anything we already
     * inject into the DOM via $.html() / .innerHTML on this app.
     */
    inst.escapeHtml = function(s) {
        return String(s).replace(/[&<>"']/g, function(c) {
            return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
        });
    };

    /**
     * Long battery label, safe for HTML interpolation.
     *   "callsign" (grid 1234567890, alt 100m)
     *   Grid 1234567890 (alt 100m)
     */
    inst.batteryLabel = function(b) {
        if (!b) return '';
        if (b.callsign && String(b.callsign).length > 0) {
            return '"' + inst.escapeHtml(b.callsign) + '" (grid '
                 + inst.escapeHtml(b.grid) + ', alt '
                 + inst.escapeHtml(String(b.altitude)) + 'm)';
        }
        return 'Grid ' + inst.escapeHtml(b.grid)
             + ' (alt ' + inst.escapeHtml(String(b.altitude)) + 'm)';
    };

    /**
     * Short battery label (no HTML escaping — for plain-text contexts and
     * inputs of escapeHtml-wrapping callers). Prefer the callsign when set,
     * otherwise fall back to the grid.
     */
    inst.batteryShort = function(b) {
        if (!b) return '';
        if (b.callsign && String(b.callsign).length > 0) return '"' + b.callsign + '"';
        return 'Grid ' + b.grid;
    };

    return inst;
}());
