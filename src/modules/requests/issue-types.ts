// ─── Static issue type catalog ───
// These map directly to inventory part types for min-price computation.

export interface IssueType {
  id: string;
  name: string;
  displayName: string;
  icon: string;
  description: string;
  defaultPartType: string | null; // maps to inventory_items.part_type
}

export const ISSUE_TYPES: IssueType[] = [
  {
    id: 'SCREEN',
    name: 'Cracked Screen',
    displayName: 'Cracked Screen',
    icon: '📱',
    description: 'Screen is cracked or shattered',
    defaultPartType: 'Screen Assembly',
  },
  {
    id: 'BATTERY',
    name: 'Battery',
    displayName: 'Battery Replacement',
    icon: '🔋',
    description: 'Battery drains fast or won\'t charge',
    defaultPartType: 'Battery',
  },
  {
    id: 'CHARGING_PORT',
    name: 'Charging Port',
    displayName: 'Charging Port Repair',
    icon: '🔌',
    description: 'Charging port broken or loose',
    defaultPartType: 'Charging Port',
  },
  {
    id: 'CAMERA',
    name: 'Camera',
    displayName: 'Camera Repair',
    icon: '📷',
    description: 'Camera not working or blurry',
    defaultPartType: 'Camera',
  },
  {
    id: 'SPEAKER',
    name: 'Speaker',
    displayName: 'Speaker Repair',
    icon: '🔊',
    description: 'Speaker crackling or no sound',
    defaultPartType: 'Speaker',
  },
  {
    id: 'BACK_GLASS',
    name: 'Back Glass',
    displayName: 'Back Glass Replacement',
    icon: '🪟',
    description: 'Back panel cracked or damaged',
    defaultPartType: 'Back Glass',
  },
  {
    id: 'WATER_DAMAGE',
    name: 'Water Damage',
    displayName: 'Water Damage Repair',
    icon: '💧',
    description: 'Device exposed to water or liquid',
    defaultPartType: null,
  },
  {
    id: 'OTHER',
    name: 'Other',
    displayName: 'Other Repair',
    icon: '🔧',
    description: 'Other issue not listed above',
    defaultPartType: null,
  },
];

/** Lookup a single issue type by id */
export function getIssueType(id: string): IssueType | undefined {
  return ISSUE_TYPES.find((t) => t.id === id);
}
