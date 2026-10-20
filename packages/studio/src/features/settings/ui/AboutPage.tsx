import {ExternalLink, Heart, QrCode} from "../../../ui/icons";
import {useRef, useState} from "react";
import {toast} from "sonner";
import {Button} from "../../../ui/button";
import {PageContent, PageHeader} from "../../../app/layout/PageLayout";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "../../../ui/dialog";
import {GITHUB_URL, LOGO_SRC, PRODUCT_NAME_EN, PRODUCT_NAME_ZH, PRODUCT_TAGLINE, STUDIO_NAME_ZH, STUDIO_URL} from "@momoki/distribution/brand";
import {isTauriRuntime} from "../../../platform/runtime/runtimeIdentity";
import {downloadBlob, isPublishedSaveError} from "../../../platform/runtime/runtimeSave";

const SPONSOR_IMAGE_SRC = "/brand/sponsor-wechat.jpg";
const SPONSOR_IMAGE_NAME = "默默-微信赞赏码.jpg";

export function AboutPage() {
    const native = isTauriRuntime();
    const saving = useRef(false);
    const [savingSponsor, setSavingSponsor] = useState(false);

    async function saveSponsor() {
        if (saving.current) return;
        saving.current = true;
        setSavingSponsor(true);
        try {
            // The bundled image belongs to the packaged WebView's own origin.
            const response = await fetch(SPONSOR_IMAGE_SRC);
            if (!response.ok) throw new Error("赞赏码图片加载失败，请重试");
            const blob = await response.blob();
            if (!blob.size || !blob.type.startsWith("image/")) throw new Error("赞赏码图片加载失败，请重试");
            const outcome = await downloadBlob(blob, SPONSOR_IMAGE_NAME);
            if (outcome === "saved") toast.success("赞赏码已保存");
            else toast.info("已取消保存赞赏码");
        } catch (error) {
            if (isPublishedSaveError(error)) toast.warning(error.message);
            else toast.error(error instanceof Error ? `保存赞赏码失败：${error.message}` : "保存赞赏码失败，请重试");
        } finally {
            saving.current = false;
            setSavingSponsor(false);
        }
    }

    return (
        <PageContent mode="document">
            <PageHeader title={`关于${PRODUCT_NAME_ZH}`}/>
            <div className="mt-6 flex items-center gap-4">
                <img src={LOGO_SRC} alt="" className="size-20 object-contain"/>
                <div>
                    <div className="font-display text-foreground text-3xl leading-tight">{PRODUCT_NAME_ZH}</div>
                    <div className="text-muted-foreground text-base">{PRODUCT_NAME_EN}</div>
                </div>
            </div>
            <p className="text-muted-foreground mt-4 max-w-xl text-sm leading-[22px]">{PRODUCT_TAGLINE}</p>
            <p className="text-muted-foreground mt-2 text-sm">{PRODUCT_NAME_ZH} · <a href={STUDIO_URL} target="_blank" rel="noreferrer" className="hover:text-foreground underline-offset-4 hover:underline">{STUDIO_NAME_ZH}</a>出品</p>

            <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="text-brand hover:text-brand/90 focus-visible:ring-ring/50 mt-4 inline-flex items-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px]"
            >
                GitHub · {PRODUCT_NAME_EN}
                <ExternalLink className="size-3.5 opacity-80" aria-hidden/>
            </a>

            <section className="mt-8 border-y py-6" aria-labelledby="support-heading">
                <div className="flex items-center gap-2">
                    <Heart className="size-4 text-muted-foreground" aria-hidden/>
                    <h2 id="support-heading" className="text-base leading-6 font-semibold">支持默默</h2>
                </div>
                <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6">
                    如果默默帮你完成了创作，欢迎请开发者喝杯咖啡，支持项目继续打磨。感谢每一份使用、反馈与支持。
                </p>
                <div className="mt-5 flex flex-wrap gap-3">
                    <Button asChild>
                        <a href="https://afdian.com/a/ROYIANS" target="_blank" rel="noopener noreferrer">
                            在爱发电支持
                            <ExternalLink aria-hidden/>
                        </a>
                    </Button>
                    <Dialog>
                        <DialogTrigger asChild>
                            <Button variant="outline"><QrCode aria-hidden/>微信赞赏码</Button>
                        </DialogTrigger>
                        <DialogContent className="flex flex-col overflow-hidden">
                            <DialogHeader>
                                <DialogTitle>感谢支持默默</DialogTitle>
                                <DialogDescription>使用微信扫一扫，或保存图片后在微信中识别赞赏码。</DialogDescription>
                            </DialogHeader>
                            <div className="min-h-0 overflow-y-auto">
                                <img
                                    src={SPONSOR_IMAGE_SRC}
                                    alt="不完美小孩的微信赞赏码"
                                    width={1152}
                                    height={1152}
                                    className="h-auto w-full rounded-md"
                                />
                            </div>
                            {native ?
                                <Button variant="outline" disabled={savingSponsor} onClick={() => void saveSponsor()}>
                                    {savingSponsor ? "正在保存赞赏码…" : "保存赞赏码"}
                                </Button> : <Button asChild variant="outline">
                                    <a href={SPONSOR_IMAGE_SRC} download={SPONSOR_IMAGE_NAME}>保存赞赏码</a>
                                </Button>}
                        </DialogContent>
                    </Dialog>
                </div>
            </section>

            <section className="mt-8 space-y-3">
                <h2 className="text-base leading-6 font-semibold">数据与隐私</h2>
                <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm leading-6">
                    <li>项目、分镜与素材默认保存在当前设备的应用或浏览器中，不依赖云端用户库。</li>
                    <li>AI 连接密钥（BYOK）只存在本机，不会写入项目备份 ZIP。</li>
                    <li>导出 / 导入由你主动触发；把备份交给谁，由你自己决定。</li>
                    <li>当前产品说明是普通语言告知，不是法律意见书；正式隐私政策可后续替换。</li>
                </ul>
            </section>

        </PageContent>
    );
}
