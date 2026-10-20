import {forwardRef} from "react";
import type {Icon, IconProps, IconWeight} from "@phosphor-icons/react/lib";
import {ArchiveIcon as PhArchive} from "@phosphor-icons/react/dist/csr/Archive";
import {ArrowBendUpLeftIcon as PhArrowBendUpLeft} from "@phosphor-icons/react/dist/csr/ArrowBendUpLeft";
import {ArrowBendDownRightIcon as PhArrowBendDownRight} from "@phosphor-icons/react/dist/csr/ArrowBendDownRight";
import {ArrowBendUpRightIcon as PhArrowBendUpRight} from "@phosphor-icons/react/dist/csr/ArrowBendUpRight";
import {ArrowClockwiseIcon as PhArrowClockwise} from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import {
    ArrowCounterClockwiseIcon as PhArrowCounterClockwise
} from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import {ArrowDownIcon as PhArrowDown} from "@phosphor-icons/react/dist/csr/ArrowDown";
import {ArrowLeftIcon as PhArrowLeft} from "@phosphor-icons/react/dist/csr/ArrowLeft";
import {ArrowRightIcon as PhArrowRight} from "@phosphor-icons/react/dist/csr/ArrowRight";
import {ArrowSquareOutIcon as PhArrowSquareOut} from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import {ArrowUpIcon as PhArrowUp} from "@phosphor-icons/react/dist/csr/ArrowUp";
import {ArrowUpRightIcon as PhArrowUpRight} from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import {ArrowsInSimpleIcon as PhArrowsInSimple} from "@phosphor-icons/react/dist/csr/ArrowsInSimple";
import {ArrowsOutSimpleIcon as PhArrowsOutSimple} from "@phosphor-icons/react/dist/csr/ArrowsOutSimple";
import {BookOpenIcon as PhBookOpen} from "@phosphor-icons/react/dist/csr/BookOpen";
import {BooksIcon as PhBooks} from "@phosphor-icons/react/dist/csr/Books";
import {CaretDownIcon as PhCaretDown} from "@phosphor-icons/react/dist/csr/CaretDown";
import {CaretRightIcon as PhCaretRight} from "@phosphor-icons/react/dist/csr/CaretRight";
import {CaretUpIcon as PhCaretUp} from "@phosphor-icons/react/dist/csr/CaretUp";
import {ChatCircleDotsIcon as PhChatCircleDots} from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import {ChatsIcon as PhChats} from "@phosphor-icons/react/dist/csr/Chats";
import {CheckIcon as PhCheck} from "@phosphor-icons/react/dist/csr/Check";
import {CheckCircleIcon as PhCheckCircle} from "@phosphor-icons/react/dist/csr/CheckCircle";
import {CheckSquareIcon as PhCheckSquare} from "@phosphor-icons/react/dist/csr/CheckSquare";
import {ChecksIcon as PhChecks} from "@phosphor-icons/react/dist/csr/Checks";
import {CircleIcon as PhCircle} from "@phosphor-icons/react/dist/csr/Circle";
import {CircleNotchIcon as PhCircleNotch} from "@phosphor-icons/react/dist/csr/CircleNotch";
import {ClipboardTextIcon as PhClipboardText} from "@phosphor-icons/react/dist/csr/ClipboardText";
import {
    ClockCounterClockwiseIcon as PhClockCounterClockwise
} from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import {CoinsIcon as PhCoins} from "@phosphor-icons/react/dist/csr/Coins";
import {ColumnsIcon as PhColumns} from "@phosphor-icons/react/dist/csr/Columns";
import {CopyIcon as PhCopy} from "@phosphor-icons/react/dist/csr/Copy";
import {CopySimpleIcon as PhCopySimple} from "@phosphor-icons/react/dist/csr/CopySimple";
import {CornersOutIcon as PhCornersOut} from "@phosphor-icons/react/dist/csr/CornersOut";
import {CrosshairIcon as PhCrosshair} from "@phosphor-icons/react/dist/csr/Crosshair";
import {CubeIcon as PhCube} from "@phosphor-icons/react/dist/csr/Cube";
import {DotsSixVerticalIcon as PhDotsSixVertical} from "@phosphor-icons/react/dist/csr/DotsSixVertical";
import {DotsThreeIcon as PhDotsThree} from "@phosphor-icons/react/dist/csr/DotsThree";
import {DownloadIcon as PhDownload} from "@phosphor-icons/react/dist/csr/Download";
import {EyeIcon as PhEye} from "@phosphor-icons/react/dist/csr/Eye";
import {FileDocIcon as PhFileDoc} from "@phosphor-icons/react/dist/csr/FileDoc";
import {FileMdIcon as PhFileMd} from "@phosphor-icons/react/dist/csr/FileMd";
import {FilePdfIcon as PhFilePdf} from "@phosphor-icons/react/dist/csr/FilePdf";
import {FileTextIcon as PhFileText} from "@phosphor-icons/react/dist/csr/FileText";
import {FileTxtIcon as PhFileTxt} from "@phosphor-icons/react/dist/csr/FileTxt";
import {FilmSlateIcon as PhFilmSlate} from "@phosphor-icons/react/dist/csr/FilmSlate";
import {FolderIcon as PhFolder} from "@phosphor-icons/react/dist/csr/Folder";
import {FolderOpenIcon as PhFolderOpen} from "@phosphor-icons/react/dist/csr/FolderOpen";
import {FunnelIcon as PhFunnel} from "@phosphor-icons/react/dist/csr/Funnel";
import {GaugeIcon as PhGauge} from "@phosphor-icons/react/dist/csr/Gauge";
import {GearIcon as PhGear} from "@phosphor-icons/react/dist/csr/Gear";
import {HandIcon as PhHand} from "@phosphor-icons/react/dist/csr/Hand";
import {HashIcon as PhHash} from "@phosphor-icons/react/dist/csr/Hash";
import {HeadphonesIcon as PhHeadphones} from "@phosphor-icons/react/dist/csr/Headphones";
import {HeartIcon as PhHeart} from "@phosphor-icons/react/dist/csr/Heart";
import {HouseIcon as PhHouse} from "@phosphor-icons/react/dist/csr/House";
import {ImageIcon as PhImage} from "@phosphor-icons/react/dist/csr/Image";
import {ImagesIcon as PhImages} from "@phosphor-icons/react/dist/csr/Images";
import {InfinityIcon as PhInfinity} from "@phosphor-icons/react/dist/csr/Infinity";
import {ListIcon as PhList} from "@phosphor-icons/react/dist/csr/List";
import {ListChecksIcon as PhListChecks} from "@phosphor-icons/react/dist/csr/ListChecks";
import {ListDashesIcon as PhListDashes} from "@phosphor-icons/react/dist/csr/ListDashes";
import {MagnifyingGlassIcon as PhMagnifyingGlass} from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import {MagnifyingGlassMinusIcon as PhMagnifyingGlassMinus} from "@phosphor-icons/react/dist/csr/MagnifyingGlassMinus";
import {MagnifyingGlassPlusIcon as PhMagnifyingGlassPlus} from "@phosphor-icons/react/dist/csr/MagnifyingGlassPlus";
import {MicrophoneIcon as PhMicrophone} from "@phosphor-icons/react/dist/csr/Microphone";
import {MicrophoneStageIcon as PhMicrophoneStage} from "@phosphor-icons/react/dist/csr/MicrophoneStage";
import {MinusIcon as PhMinus} from "@phosphor-icons/react/dist/csr/Minus";
import {MusicNoteIcon as PhMusicNote} from "@phosphor-icons/react/dist/csr/MusicNote";
import {PaperclipIcon as PhPaperclip} from "@phosphor-icons/react/dist/csr/Paperclip";
import {PauseIcon as PhPause} from "@phosphor-icons/react/dist/csr/Pause";
import {PenNibIcon as PhPenNib} from "@phosphor-icons/react/dist/csr/PenNib";
import {PencilSimpleIcon as PhPencilSimple} from "@phosphor-icons/react/dist/csr/PencilSimple";
import {PlayIcon as PhPlay} from "@phosphor-icons/react/dist/csr/Play";
import {PlugsIcon as PhPlugs} from "@phosphor-icons/react/dist/csr/Plugs";
import {PlusIcon as PhPlus} from "@phosphor-icons/react/dist/csr/Plus";
import {PrinterIcon as PhPrinter} from "@phosphor-icons/react/dist/csr/Printer";
import {PushPinIcon as PhPushPin} from "@phosphor-icons/react/dist/csr/PushPin";
import {QrCodeIcon as PhQrCode} from "@phosphor-icons/react/dist/csr/QrCode";
import {QuestionIcon as PhQuestion} from "@phosphor-icons/react/dist/csr/Question";
import {ScissorsIcon as PhScissors} from "@phosphor-icons/react/dist/csr/Scissors";
import {ShieldIcon as PhShield} from "@phosphor-icons/react/dist/csr/Shield";
import {ShieldCheckIcon as PhShieldCheck} from "@phosphor-icons/react/dist/csr/ShieldCheck";
import {ShieldWarningIcon as PhShieldWarning} from "@phosphor-icons/react/dist/csr/ShieldWarning";
import {SidebarIcon as PhSidebar} from "@phosphor-icons/react/dist/csr/Sidebar";
import {SidebarSimpleIcon as PhSidebarSimple} from "@phosphor-icons/react/dist/csr/SidebarSimple";
import {SkipBackIcon as PhSkipBack} from "@phosphor-icons/react/dist/csr/SkipBack";
import {SkipForwardIcon as PhSkipForward} from "@phosphor-icons/react/dist/csr/SkipForward";
import {SlidersHorizontalIcon as PhSlidersHorizontal} from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import {SmileyIcon as PhSmiley} from "@phosphor-icons/react/dist/csr/Smiley";
import {SparkleIcon as PhSparkle} from "@phosphor-icons/react/dist/csr/Sparkle";
import {SpeakerHighIcon as PhSpeakerHigh} from "@phosphor-icons/react/dist/csr/SpeakerHigh";
import {SpeakerSlashIcon as PhSpeakerSlash} from "@phosphor-icons/react/dist/csr/SpeakerSlash";
import {SquareIcon as PhSquare} from "@phosphor-icons/react/dist/csr/Square";
import {StackIcon as PhStack} from "@phosphor-icons/react/dist/csr/Stack";
import {TShirtIcon as PhTShirt} from "@phosphor-icons/react/dist/csr/TShirt";
import {TextTIcon as PhTextT} from "@phosphor-icons/react/dist/csr/TextT";
import {TrayIcon as PhTray} from "@phosphor-icons/react/dist/csr/Tray";
import {TrashIcon as PhTrash} from "@phosphor-icons/react/dist/csr/Trash";
import {UploadIcon as PhUpload} from "@phosphor-icons/react/dist/csr/Upload";
import {UsersIcon as PhUsers} from "@phosphor-icons/react/dist/csr/Users";
import {VideoCameraIcon as PhVideoCamera} from "@phosphor-icons/react/dist/csr/VideoCamera";
import {WarningIcon as PhWarning} from "@phosphor-icons/react/dist/csr/Warning";
import {WarningCircleIcon as PhWarningCircle} from "@phosphor-icons/react/dist/csr/WarningCircle";
import {WrenchIcon as PhWrench} from "@phosphor-icons/react/dist/csr/Wrench";
import {XIcon as PhX} from "@phosphor-icons/react/dist/csr/X";
import {PaletteIcon as PhPalette} from "@phosphor-icons/react/dist/csr/Palette";
import {DatabaseIcon as PhDatabase} from "@phosphor-icons/react/dist/csr/Database";
import {InfoIcon as PhInfo} from "@phosphor-icons/react/dist/csr/Info";

/** Application-owned glyphs; model/provider marks retain their brand owner. */
function appIcon(Glyph: Icon, defaultWeight: IconWeight = "regular", mirror = false) {
    return forwardRef<SVGSVGElement, IconProps>(function AppIcon({
                                                                     fill: _fill,
                                                                     stroke: _stroke,
                                                                     strokeWidth: _strokeWidth,
                                                                     strokeLinecap: _strokeLinecap,
                                                                     strokeLinejoin: _strokeLinejoin,
                                                                     strokeMiterlimit: _strokeMiterlimit,
                                                                     strokeDasharray: _strokeDasharray,
                                                                     strokeDashoffset: _strokeDashoffset,
                                                                     width: _width,
                                                                     height: _height,
                                                                     viewBox: _viewBox,
                                                                     size = 24,
                                                                     weight = defaultWeight,
                                                                     mirrored = mirror,
                                                                     ...props
                                                                 }, ref) {
        // LobeUI forwards transparent fill and stroke props. Official geometry
        // owns those attributes; preserve semantic size, color, weight and ref.
        return <Glyph {...props} ref={ref} size={size} weight={weight} mirrored={mirrored}/>;
    });
}

export const AlertTriangle = /* @__PURE__ */ appIcon(PhWarning);
export const Archive = /* @__PURE__ */ appIcon(PhArchive);
export const ArrowDown = /* @__PURE__ */ appIcon(PhArrowDown);
export const ArrowLeft = /* @__PURE__ */ appIcon(PhArrowLeft);
export const ArrowRight = /* @__PURE__ */ appIcon(PhArrowRight);
export const CornerDownRight = /* @__PURE__ */ appIcon(PhArrowBendDownRight);
export const ArrowUp = /* @__PURE__ */ appIcon(PhArrowUp);
export const ArrowUpRight = /* @__PURE__ */ appIcon(PhArrowUpRight);
export const BookOpen = /* @__PURE__ */ appIcon(PhBookOpen);
export const Boxes = /* @__PURE__ */ appIcon(PhCube);
export const Check = /* @__PURE__ */ appIcon(PhCheck);
export const CheckCheck = /* @__PURE__ */ appIcon(PhChecks);
export const CheckCircle2 = /* @__PURE__ */ appIcon(PhCheckCircle);
export const CheckIcon = /* @__PURE__ */ appIcon(PhCheck);
export const CheckSquare = /* @__PURE__ */ appIcon(PhCheckSquare);
export const ChevronDown = /* @__PURE__ */ appIcon(PhCaretDown);
export const ChevronDownIcon = /* @__PURE__ */ appIcon(PhCaretDown);
export const ChevronRight = /* @__PURE__ */ appIcon(PhCaretRight);
export const ChevronRightIcon = /* @__PURE__ */ appIcon(PhCaretRight);
export const ChevronUp = /* @__PURE__ */ appIcon(PhCaretUp);
export const ChevronUpIcon = /* @__PURE__ */ appIcon(PhCaretUp);
export const Circle = /* @__PURE__ */ appIcon(PhCircle);
export const CircleAlert = /* @__PURE__ */ appIcon(PhWarningCircle);
export const Clapperboard = /* @__PURE__ */ appIcon(PhFilmSlate);
export const ClipboardCheck = /* @__PURE__ */ appIcon(PhClipboardText);
export const Coins = /* @__PURE__ */ appIcon(PhCoins);
export const Columns3 = /* @__PURE__ */ appIcon(PhColumns);
export const Copy = /* @__PURE__ */ appIcon(PhCopy);
export const CopyPlus = /* @__PURE__ */ appIcon(PhCopySimple);
export const Download = /* @__PURE__ */ appIcon(PhDownload);
export const Ellipsis = /* @__PURE__ */ appIcon(PhDotsThree);
export const Expand = /* @__PURE__ */ appIcon(PhCornersOut);
export const ExternalLink = /* @__PURE__ */ appIcon(PhArrowSquareOut);
export const Eye = /* @__PURE__ */ appIcon(PhEye);
export const FileDoc = /* @__PURE__ */ appIcon(PhFileDoc, "fill");
export const FileMd = /* @__PURE__ */ appIcon(PhFileMd, "fill");
export const FilePdf = /* @__PURE__ */ appIcon(PhFilePdf, "fill");
export const FileText = /* @__PURE__ */ appIcon(PhFileText);
export const FileTxt = /* @__PURE__ */ appIcon(PhFileTxt, "fill");
export const Filter = /* @__PURE__ */ appIcon(PhFunnel);
export const Folder = /* @__PURE__ */ appIcon(PhFolder);
export const FolderOpen = /* @__PURE__ */ appIcon(PhFolderOpen);
export const Gauge = /* @__PURE__ */ appIcon(PhGauge);
export const GripVertical = /* @__PURE__ */ appIcon(PhDotsSixVertical);
export const Hand = /* @__PURE__ */ appIcon(PhHand);
export const Hash = /* @__PURE__ */ appIcon(PhHash);
export const Headphones = /* @__PURE__ */ appIcon(PhHeadphones);
export const Heart = /* @__PURE__ */ appIcon(PhHeart);
export const HeartFill = /* @__PURE__ */ appIcon(PhHeart, "fill");
export const History = /* @__PURE__ */ appIcon(PhClockCounterClockwise);
export const Image = /* @__PURE__ */ appIcon(PhImage);
export const ImageIcon = /* @__PURE__ */ appIcon(PhImage);
export const Images = /* @__PURE__ */ appIcon(PhImages);
const InfinityIcon = /* @__PURE__ */ appIcon(PhInfinity);
export const Layers = /* @__PURE__ */ appIcon(PhStack);
export const Layers3 = /* @__PURE__ */ appIcon(PhStack);
export const LayoutList = /* @__PURE__ */ appIcon(PhList);
export const Library = /* @__PURE__ */ appIcon(PhBooks);
export const ListTodo = /* @__PURE__ */ appIcon(PhListChecks);
export const QueueList = /* @__PURE__ */ appIcon(PhListDashes);
export const LoaderCircle = /* @__PURE__ */ appIcon(PhCircleNotch);
export const Maximize2 = /* @__PURE__ */ appIcon(PhArrowsOutSimple);
export const MessageSquarePlus = /* @__PURE__ */ appIcon(PhChatCircleDots);
export const MessagesSquare = /* @__PURE__ */ appIcon(PhChats);
export const Mic = /* @__PURE__ */ appIcon(PhMicrophone);
export const Mic2 = /* @__PURE__ */ appIcon(PhMicrophoneStage);
export const Minimize2 = /* @__PURE__ */ appIcon(PhArrowsInSimple);
export const Minus = /* @__PURE__ */ appIcon(PhMinus);
export const MoreHorizontal = /* @__PURE__ */ appIcon(PhDotsThree);
export const Music2 = /* @__PURE__ */ appIcon(PhMusicNote);
export const PackageOpen = /* @__PURE__ */ appIcon(PhCube);
export const PanelLeft = /* @__PURE__ */ appIcon(PhSidebar);
export const PanelRightClose = /* @__PURE__ */ appIcon(PhSidebarSimple, "regular", true);
export const PanelRightOpen = /* @__PURE__ */ appIcon(PhSidebarSimple, "regular", true);
export const Paperclip = /* @__PURE__ */ appIcon(PhPaperclip);
export const Pause = /* @__PURE__ */ appIcon(PhPause);
export const PenLine = /* @__PURE__ */ appIcon(PhPenNib);
export const Pencil = /* @__PURE__ */ appIcon(PhPencilSimple);
export const Pin = /* @__PURE__ */ appIcon(PhPushPin);
export const Play = /* @__PURE__ */ appIcon(PhPlay);
export const Plug = /* @__PURE__ */ appIcon(PhPlugs);
export const Plus = /* @__PURE__ */ appIcon(PhPlus);
export const Printer = /* @__PURE__ */ appIcon(PhPrinter);
export const QrCode = /* @__PURE__ */ appIcon(PhQrCode);
export const CircleHelp = /* @__PURE__ */ appIcon(PhQuestion);
export const Redo2 = /* @__PURE__ */ appIcon(PhArrowBendUpRight);
export const RefreshCw = /* @__PURE__ */ appIcon(PhArrowClockwise);
export const Restore = /* @__PURE__ */ appIcon(PhArrowCounterClockwise);
export const RotateCcw = /* @__PURE__ */ appIcon(PhArrowCounterClockwise);
export const Scissors = /* @__PURE__ */ appIcon(PhScissors);
export const Search = /* @__PURE__ */ appIcon(PhMagnifyingGlass);
export const Settings = /* @__PURE__ */ appIcon(PhGear);
export const Settings2 = /* @__PURE__ */ appIcon(PhSlidersHorizontal);
export const ShieldAlert = /* @__PURE__ */ appIcon(PhShieldWarning);
export const ShieldCheck = /* @__PURE__ */ appIcon(PhShieldCheck);
export const ShieldQuestion = /* @__PURE__ */ appIcon(PhShield);
export const Shirt = /* @__PURE__ */ appIcon(PhTShirt);
export const SkipBack = /* @__PURE__ */ appIcon(PhSkipBack);
export const SkipForward = /* @__PURE__ */ appIcon(PhSkipForward);
export const SlidersHorizontal = /* @__PURE__ */ appIcon(PhSlidersHorizontal);
export const Smile = /* @__PURE__ */ appIcon(PhSmiley);
export const Snap = /* @__PURE__ */ appIcon(PhCrosshair);
export const Sparkles = /* @__PURE__ */ appIcon(PhSparkle);
export const Square = /* @__PURE__ */ appIcon(PhSquare);
export const SquareStack = /* @__PURE__ */ appIcon(PhStack);
export const Tray = /* @__PURE__ */ appIcon(PhTray);
export const Trash2 = /* @__PURE__ */ appIcon(PhTrash);
export const TriangleAlert = /* @__PURE__ */ appIcon(PhWarning);
export const Type = /* @__PURE__ */ appIcon(PhTextT);
export const Undo2 = /* @__PURE__ */ appIcon(PhArrowBendUpLeft);
export const Upload = /* @__PURE__ */ appIcon(PhUpload);
export const Users = /* @__PURE__ */ appIcon(PhUsers);
export const Video = /* @__PURE__ */ appIcon(PhVideoCamera);
export const Volume2 = /* @__PURE__ */ appIcon(PhSpeakerHigh);
export const VolumeX = /* @__PURE__ */ appIcon(PhSpeakerSlash);
export const Wrench = /* @__PURE__ */ appIcon(PhWrench);
export const X = /* @__PURE__ */ appIcon(PhX);
export const XIcon = /* @__PURE__ */ appIcon(PhX);
export const ZoomIn = /* @__PURE__ */ appIcon(PhMagnifyingGlassPlus);
export const ZoomOut = /* @__PURE__ */ appIcon(PhMagnifyingGlassMinus);
export {InfinityIcon as Infinity};
export const Home = /* @__PURE__ */ appIcon(PhHouse);
export const Menu = /* @__PURE__ */ appIcon(PhList);
export const Info = /* @__PURE__ */ appIcon(PhInfo);
export const Palette = /* @__PURE__ */ appIcon(PhPalette);
export const Database = /* @__PURE__ */ appIcon(PhDatabase);
