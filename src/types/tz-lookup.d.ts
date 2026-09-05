declare module 'tz-lookup' {
  /**
   * Returns the IANA timezone name (e.g. "America/New_York") for the given
   * latitude/longitude, or null if it cannot be determined.
   */
  const tzLookup: (latitude: number, longitude: number) => string | null;
  export default tzLookup;
}