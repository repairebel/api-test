import { z } from 'zod';

export const ISSUE_CATEGORIES: Record<string, string> = {
  BACK_GLASS: 'Back Glass', BATTERY: 'Battery', BUTTONS_FLEX: 'Buttons & Flex',
  CAMERA: 'Camera', CAMERA_LENS: 'Camera Lens', CHARGING_PORT: 'Charging Port',
  FRONT_CAMERA: 'Front Camera', HOUSING: 'Housing', INNER_SCREEN: 'Inner Screen',
  MICROPHONE: 'Microphone', MOTHERBOARD_IC: 'Motherboard & IC', OUTER_SCREEN: 'Outer Screen',
  REAR_CAMERA: 'Rear Camera', REAR_MACRO_CAMERA: 'Rear Macro Camera',
  REAR_TELEPHOTO_CAMERA: 'Rear Telephoto Camera', REAR_ULTRA_WIDE_CAMERA: 'Rear Ultra Wide Camera',
  SCREEN: 'Screen', SIM_TRAY: 'SIM Tray', SPEAKER: 'Speaker', VIBRATION_MOTOR: 'Vibration Motor',
  OTHER: 'Others',
};
export const customPartNameSchema = z.string().trim().min(1).max(200)
  .transform(value => value.replace(/\s+/gu, ' '))
  .refine(value => value.split(' ').length <= 10, 'Use at most 10 words for the custom part name.');

export function parseRepair(issueType: string, customPartName?: string) {
  if (!Object.hasOwn(ISSUE_CATEGORIES, issueType)) throw new Error('Choose a valid issue category.');
  if (issueType === 'OTHER') {
    const name = customPartNameSchema.parse(customPartName);
    return { issueType, customPartName: name, label: `Others — ${name}` };
  }
  if (customPartName?.trim()) throw new Error('A custom part name is only allowed for Others.');
  return { issueType, customPartName: undefined, label: ISSUE_CATEGORIES[issueType]! };
}
