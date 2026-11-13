import {
  ArrowRight,
  Ban,
  Building2,
  CalendarDays,
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Download,
  Ellipsis,
  Eye,
  Flashlight,
  History,
  Hourglass,
  IdCard,
  Image,
  ImageUp,
  Inbox,
  Info,
  KeyRound,
  LayoutDashboard,
  ListFilter,
  LoaderCircle,
  LogOut,
  Mail,
  MapPin,
  Menu,
  Phone,
  Plus,
  Printer,
  QrCode,
  RefreshCw,
  ScanLine,
  Search,
  SearchX,
  ShieldCheck,
  Smartphone,
  SwitchCamera,
  Timer,
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * The app's icons: Lucide, under the names the rest of the code uses. Each one is decorative (the
 * button or label next to it carries the meaning), so it is hidden from screen readers, and sized
 * with Tailwind classes (`h-4 w-4`), 20 px by default.
 */
export type IconProps = Omit<LucideProps, 'ref'>;
export type AppIcon = (props: IconProps) => React.JSX.Element;

function icon(Glyph: LucideIcon, strokeWidth = 2): AppIcon {
  const Wrapped: AppIcon = ({ className, ...rest }) => (
    <Glyph
      aria-hidden="true"
      focusable="false"
      strokeWidth={strokeWidth}
      className={cn('h-5 w-5 shrink-0', className)}
      {...rest}
    />
  );
  return Wrapped;
}

export const CameraIcon = icon(Camera);
export const CameraOffIcon = icon(CameraOff);
export const SwitchCameraIcon = icon(SwitchCamera);
export const CheckIcon = icon(Check, 2.5);
export const XIcon = icon(X);
export const AlertIcon = icon(TriangleAlert);
export const AlertCircleIcon = icon(CircleAlert);
export const CheckCircleIcon = icon(CircleCheck);
export const XCircleIcon = icon(CircleX);
export const InfoIcon = icon(Info);
export const QrIcon = icon(QrCode);
export const DownloadIcon = icon(Download);
export const RefreshIcon = icon(RefreshCw);
export const BanIcon = icon(Ban);
export const LogOutIcon = icon(LogOut);
export const SearchIcon = icon(Search);
export const SearchOffIcon = icon(SearchX);
export const UserIcon = icon(UserRound);
export const UsersIcon = icon(Users);
export const UserPlusIcon = icon(UserPlus);
export const ClockIcon = icon(Clock);
export const ScanIcon = icon(ScanLine);
export const ImageIcon = icon(Image);
export const ImageUpIcon = icon(ImageUp);
export const TorchIcon = icon(Flashlight);
export const ShieldCheckIcon = icon(ShieldCheck);
export const HistoryIcon = icon(History);
export const ChevronLeftIcon = icon(ChevronLeft);
export const ChevronRightIcon = icon(ChevronRight);
export const ChevronDownIcon = icon(ChevronDown);
export const DashboardIcon = icon(LayoutDashboard);
export const MoreIcon = icon(Ellipsis);
export const MenuIcon = icon(Menu);
export const MapPinIcon = icon(MapPin);
export const WifiIcon = icon(Wifi);
export const WifiOffIcon = icon(WifiOff);
export const MailIcon = icon(Mail);
export const PhoneIcon = icon(Phone);
export const BuildingIcon = icon(Building2);
export const IdCardIcon = icon(IdCard);
export const CalendarIcon = icon(CalendarDays);
export const PrinterIcon = icon(Printer);
export const EyeIcon = icon(Eye);
export const FilterIcon = icon(ListFilter);
export const ArrowRightIcon = icon(ArrowRight);
export const TimerIcon = icon(Timer);
export const HourglassIcon = icon(Hourglass);
export const InboxIcon = icon(Inbox);
export const KeyIcon = icon(KeyRound);
export const CopyIcon = icon(Copy);
export const PlusIcon = icon(Plus);
export const SmartphoneIcon = icon(Smartphone);

export const SpinnerIcon: AppIcon = ({ className, ...rest }) => (
  <LoaderCircle
    aria-hidden="true"
    focusable="false"
    className={cn('spin h-5 w-5 shrink-0', className)}
    {...rest}
  />
);
