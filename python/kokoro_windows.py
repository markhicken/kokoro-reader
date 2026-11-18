"""CPU Kokoro backend for the Windows sidecar."""

from functools import cache

from kokoro_server import serve


def main() -> None:
    from kokoro import KPipeline

    repo_id = "hexgrad/Kokoro-82M"
    english = KPipeline(lang_code="a", repo_id=repo_id, device="cpu")
    english.load_voice("af_heart")

    @cache
    def get_pipeline(lang):
        if lang == "a":
            return english
        return KPipeline(lang_code=lang, repo_id=repo_id, model=english.model)

    serve(get_pipeline, 24000)


if __name__ == "__main__":
    main()
